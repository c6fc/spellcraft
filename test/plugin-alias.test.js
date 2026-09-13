'use strict';

/*
 * A plugin installed under an npm alias.
 *
 *     npm install 'myplugins@npm:@c6fc/spellcraft-plugins'
 *
 * The two discovery paths key their bookkeeping on different names --
 * loadPluginsFromDependencies() on the dependency name as *written* in
 * package.json, loadPluginsRecursively() on depPkg.name -- and under an alias
 * those differ, so the name-keyed guard in loadPlugin() missed and the same file
 * on disk was extended into the frame twice. Measured before the fix: every
 * init() hook ran twice per render, and every yargs command was registered
 * twice, visibly, in --help.
 *
 * It looked harmless because @c6fc/spellcraft-plugins' own init hooks are
 * memoised and idempotent. One that allocates, appends to a list, spawns a
 * process or counts gets it done twice with nothing to see.
 *
 * Registering the *natives* under both names is deliberate and stays: the alias
 * is what the manifest author types, while a plugin's own module.libsonnet
 * hardcodes the real package name, so both have to resolve.
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

const scratchDirs = [];

test.after(() => {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A project depending on `installedAs`, where that directory holds a plugin
// whose package.json calls itself something else -- which is all an npm alias
// looks like from disk.
function aliasedProject(installedAs, realName) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-alias-'));
    scratchDirs.push(dir);

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        dependencies: { [installedAs]: `npm:${realName}@1.0.0` },
    }));

    const pluginDir = path.join(dir, 'node_modules', installedAs);
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
        name: realName,
        version: '1.0.0',
        main: 'index.js',
        spellcraft: true,
    }));

    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        exports._spellcraft_metadata = {
            init: async () => {},
            cliExtensions: (yargs) => yargs,
            functionContext: { marker: true },
        };

        exports.hello = () => "hi";
    `);

    return dir;
}

test('an aliased plugin is extended into the frame exactly once', () => {
    const frame = new SpellFrame({ baseDir: aliasedProject('myplugins', 'fake-plugin') });

    assert.strictEqual(frame.initFn.length, 1, `init hooks: ${frame.initFn.length}`);
    assert.strictEqual(frame.cliExtensions.length, 1, `cli extensions: ${frame.cliExtensions.length}`);
});

test('its natives are still reachable under both names', async () => {
    const frame = new SpellFrame({ baseDir: aliasedProject('myplugins', 'fake-plugin') });

    const rendered = await frame.renderString(`{
        aliased: std.native("myplugins:hello")(),
        real: std.native("fake-plugin:hello")(),
    }`);

    assert.deepStrictEqual(rendered, { aliased: 'hi', real: 'hi' });
});

test('a requires: naming either name resolves', () => {
    const frame = new SpellFrame({ baseDir: aliasedProject('myplugins', 'fake-plugin') });

    assert.strictEqual(frame.loadedPlugins.has('myplugins'), true);
    assert.strictEqual(frame.loadedPlugins.has('fake-plugin'), true);
    assert.deepStrictEqual(frame.pluginRequirementErrors, []);
});

test('an ordinary, unaliased install is unaffected', () => {
    const frame = new SpellFrame({ baseDir: aliasedProject('fake-plugin', 'fake-plugin') });

    assert.strictEqual(frame.initFn.length, 1);
    assert.strictEqual(frame.cliExtensions.length, 1);
    assert.strictEqual(frame.loadedPlugins.size, 1);
});
