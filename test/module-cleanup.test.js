'use strict';

/*
 * The generated spellcraft_modules aggregate, and the flag that keeps it.
 *
 * `.spellcraft/modules` is a build artifact: loadLocalMagicModules() turns every
 * spellcraft_modules/*.js into one Jsonnet object so a manifest can import it.
 * It is also the only place you can see what those files actually became, which
 * matters because a module that throws on load is only *warned* about -- the
 * visible symptom is the manifest failing later with `field does not exist`,
 * naming a function the aggregate never got. Reading it is how you find out why.
 *
 * So it is cleaned by default and kept on request, and the failure case is the
 * one the flag exists for -- tested here rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

const AGGREGATE = path.join('.spellcraft', 'modules');

// A project with one local module. `body` is the module's JS, so a test can make
// it load cleanly or throw on require.
function project(body = 'exports.greet = () => "hello";\n') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-modclean-'));

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    fs.mkdirSync(path.join(dir, 'spellcraft_modules'));
    fs.writeFileSync(path.join(dir, 'spellcraft_modules', 'greeter.js'), body);

    return dir;
}

const aggregateExists = (dir) => fs.existsSync(path.join(dir, AGGREGATE));

test('the aggregate is generated, usable, and cleaned away afterwards', async () => {
    const dir = project();
    const frame = new SpellFrame({ baseDir: dir });

    const rendered = await frame.renderString('{ said: (import "modules").greeter.greet() }');

    assert.strictEqual(rendered.said, 'hello', 'the module was not reachable from Jsonnet');
    assert.strictEqual(aggregateExists(dir), false, 'the generated aggregate was left behind');
});

test('cleanModulesAfterRender: false keeps it, with the real content', async () => {
    const dir = project();
    const frame = new SpellFrame({ baseDir: dir, cleanModulesAfterRender: false });

    await frame.renderString('{ said: (import "modules").greeter.greet() }');

    assert.strictEqual(aggregateExists(dir), true, 'the flag did not keep the aggregate');
    // Field names are quoted -- see loadLocalMagicModules() for why that is
    // load-bearing rather than cosmetic.
    assert.match(fs.readFileSync(path.join(dir, AGGREGATE), 'utf8'), /"greet"\(\):: std\.native/);
});

test('a second render on the same frame still works after a clean', async () => {
    // Cleanup deletes the file the next evaluation needs, so it is regenerated
    // per evaluation rather than once at construction. Without that, this throws
    // "couldn't open import".
    const dir = project();
    const frame = new SpellFrame({ baseDir: dir });

    await frame.renderString('{ said: (import "modules").greeter.greet() }');
    const second = await frame.renderString('{ said: (import "modules").greeter.greet() }');

    assert.strictEqual(second.said, 'hello', 'the second render lost the module aggregate');
});

test('an edit between renders is picked up', async () => {
    const dir = project();
    const frame = new SpellFrame({ baseDir: dir });

    const first = await frame.renderString('{ said: (import "modules").greeter.greet() }');
    assert.strictEqual(first.said, 'hello');

    fs.writeFileSync(path.join(dir, 'spellcraft_modules', 'greeter.js'), 'exports.greet = () => "goodbye";\n');

    const second = await frame.renderString('{ said: (import "modules").greeter.greet() }');
    assert.strictEqual(second.said, 'goodbye', 'a module edited between renders was not reloaded');
});

test('a failed render cleans up too, so nothing is left lying around', async () => {
    const dir = project();
    const frame = new SpellFrame({ baseDir: dir });

    await assert.rejects(() => frame.renderString('{ broken: '));
    assert.strictEqual(aggregateExists(dir), false, 'a failed render left the aggregate behind');
});

test('the flag keeps the aggregate when a module fails to load', async () => {
    // The case the flag exists for. A module that throws on require is only
    // warned about, so the manifest fails naming a function that is missing --
    // and the aggregate is the evidence for why it is missing. Cleaning it away
    // on the failing run is exactly when you least want it gone, so: re-run with
    // the flag, and read it.
    const dir = project('throw new Error("this module is broken");\n');
    const frame = new SpellFrame({ baseDir: dir, cleanModulesAfterRender: false });

    await assert.rejects(
        () => frame.renderString('{ said: (import "modules").greeter.greet() }'),
        /greeter/,
    );

    assert.strictEqual(aggregateExists(dir), true, 'the aggregate was cleaned despite the flag');

    // And it shows what actually happened: the module contributed nothing, which
    // is the answer to "why does my manifest say this field does not exist".
    const content = fs.readFileSync(path.join(dir, AGGREGATE), 'utf8');
    assert.doesNotMatch(content, /greet/, 'the broken module appeared in the aggregate anyway');
});
