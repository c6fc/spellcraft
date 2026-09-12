'use strict';

/*
 * Three behaviours that were each wrong in a way nothing would have noticed.
 *
 * All three are invisible from the CLI's own usage -- one frame, one render,
 * one process -- which is exactly why they survived. They bite a library
 * consumer, a listener, and anyone whose install is half-finished.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-frame-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    return dir;
}

test('a native emits its event on every call, not just the first', async () => {
    const frame = new SpellFrame({ baseDir: project() });

    let calls = 0;
    frame.addNativeFunction('counted', () => 'value');
    frame.on('counted', () => { calls++; });

    // Same arguments twice, so the second is a cache hit. The event used to be
    // emitted below the cache check, so a listener saw one call however many
    // times the manifest asked.
    await frame.renderString('{ a: std.native("counted")(), b: std.native("counted")() }');

    assert.strictEqual(calls, 2, 'the cached call did not emit');
});

test('the native memo cache does not survive into the next render', async () => {
    const frame = new SpellFrame({ baseDir: project() });

    let answer = 'first';
    frame.addNativeFunction('changing', () => answer);

    // renderString() returns the parsed manifest, not a JSON string.
    const one = await frame.renderString('{ value: std.native("changing")() }');
    assert.strictEqual(one.value, 'first');

    // A second render on the same frame must ask again. It used to replay the
    // first render's answer -- including, in a real spell, whatever a live API
    // said some time ago.
    answer = 'second';
    const two = await frame.renderString('{ value: std.native("changing")() }');

    assert.strictEqual(two.value, 'second', 'the second render replayed a stale value');
});

test('the memo cache still holds within a single render', async () => {
    // The other half of the rule above, and the load-bearing one:
    // gcp.terraform's googleOrgProject() is unusable without this.
    const frame = new SpellFrame({ baseDir: project() });

    let calls = 0;
    frame.addNativeFunction('expensive', () => { calls++; return 'value'; });

    await frame.renderString('{ a: std.native("expensive")(), b: std.native("expensive")() }');

    assert.strictEqual(calls, 1, 'memoization within a render was lost');
});

// A real broken install: a project depending on a plugin whose declared
// `requires` names a package that was never installed. Built on disk rather
// than by poking loadedPlugins, because the bug being guarded is in the
// constructor -- it has to actually discover the plugin to reach it.
function brokenInstall() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-requires-'));
    const pluginDir = path.join(dir, 'node_modules', '@example', 'needs-auth');

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { '@example/needs-auth': '^1.0.0' } }),
    );
    fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({ name: '@example/needs-auth', version: '1.0.0', main: 'module.js', spellcraft: true }),
    );
    fs.writeFileSync(
        path.join(pluginDir, 'module.js'),
        "module.exports = { _spellcraft_metadata: { requires: ['@example/auth'] } };\n",
    );

    return dir;
}

test('a missing plugin dependency does not break constructing a frame', () => {
    // This used to throw from the constructor, which runs before yargs has done
    // anything -- so `spellcraft --help` and `spellcraft doc` were unreachable in
    // a project with one bad install, and the user got a stack trace rather than
    // the message naming what to install.
    const frame = new SpellFrame({ baseDir: brokenInstall() });

    assert.strictEqual(frame.pluginRequirementErrors.length, 1);
    assert.match(frame.pluginRequirementErrors[0], /npm install --save @example\/auth/);
});

test('a missing plugin dependency still fails anything that renders', async () => {
    const frame = new SpellFrame({ baseDir: brokenInstall() });

    await assert.rejects(
        () => frame.renderString('{ a: 1 }'),
        /requires '@example\/auth'/,
        'an evaluation proceeded against an unsatisfied plugin set',
    );
});

test('a missing plugin dependency fails init() before any hook runs', async () => {
    // Ordering, not just failure: init() must raise before a plugin's own init
    // authenticates for a plugin set that was never satisfied.
    const frame = new SpellFrame({ baseDir: brokenInstall() });

    let hookRan = false;
    frame.initFn.push(() => { hookRan = true; });

    await assert.rejects(() => frame.init(), /requires '@example\/auth'/);
    assert.strictEqual(hookRan, false, 'an init hook ran despite an unsatisfied plugin set');
});
