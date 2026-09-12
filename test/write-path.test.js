'use strict';

/*
 * The manifest contract: filename -> content, inside renderPath.
 *
 * That is deliberately narrow. Anything outside it -- a file mode, a path
 * elsewhere on disk, a value that does not exist until apply -- is Terraform's
 * job, via a local_file resource. Keeping the contract narrow is what lets
 * cleanBeforeRender delete exactly what it wrote and nothing else, so the cases
 * below are enforcing a design decision rather than patching around one.
 *
 * All of this was previously unenforced: a key could escape renderPath, a key
 * naming a subdirectory failed, an array rendered to files called "0" and "1",
 * and a write that failed was reported as a successful run.
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

const scratchDirs = [];

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-writepath-'));
    scratchDirs.push(dir);
    return dir;
}

test.after(() => {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('a key naming a subdirectory is created and written', () => {
    const renderPath = path.join(scratch(), 'render');
    new SpellFrame({ renderPath }).write({ 'sub/dir/file.json': { a: 1 } });

    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(renderPath, 'sub', 'dir', 'file.json'), 'utf-8')),
        { a: 1 },
    );
});

test('a key that escapes renderPath is refused, and nothing is written', () => {
    const root = scratch();
    const renderPath = path.join(root, 'render');
    const escaped = path.join(root, 'escaped.json');

    assert.throws(
        () => new SpellFrame({ renderPath }).write({ '../escaped.json': { a: 1 } }),
        /resolves outside/,
    );

    assert.equal(fs.existsSync(escaped), false, 'a manifest key wrote outside renderPath');
});

test('the refusal points at the supported route', () => {
    const renderPath = path.join(scratch(), 'render');

    assert.throws(
        () => new SpellFrame({ renderPath }).write({ '../x.json': {} }),
        /local_file/,
        'the error should name the Terraform route rather than just refusing',
    );
});

test('a stale manifest naming an escaping path does not delete outside renderPath', () => {
    // The half that destroys something. A manifest written before write() refused
    // these can still name one, and clean resolves whatever it is handed.
    const root = scratch();
    const renderPath = path.join(root, 'render');
    const victim = path.join(root, 'precious.md');

    fs.mkdirSync(path.join(renderPath, '.spellcraft'), { recursive: true });
    fs.writeFileSync(victim, 'do not delete');
    fs.writeFileSync(
        path.join(renderPath, '.spellcraft', 'manifest.json'),
        JSON.stringify(['../precious.md']),
    );

    new SpellFrame({ renderPath }).write({ 'fresh.md': 'new' });

    assert.equal(fs.readFileSync(victim, 'utf-8'), 'do not delete', 'clean deleted outside renderPath');
});

test('a manifest that renders to an array is refused by name', () => {
    const renderPath = path.join(scratch(), 'render');

    assert.throws(
        () => new SpellFrame({ renderPath }).write(['a', 'b']),
        /produced an array/,
    );

    // The old behaviour: an array satisfies `typeof === 'object'`, so it was
    // walked by index and produced files called "0" and "1".
    assert.equal(fs.existsSync(path.join(renderPath, '0')), false);
});

test('a manifest that renders to a scalar is refused by name', () => {
    const renderPath = path.join(scratch(), 'render');

    assert.throws(() => new SpellFrame({ renderPath }).write('just a string'), /produced a string/);
    assert.throws(() => new SpellFrame({ renderPath }).write(42), /produced a number/);
});

test('a write that fails makes the run fail, naming the file', () => {
    const renderPath = path.join(scratch(), 'render');
    const frame = new SpellFrame({ renderPath });

    frame.addFileTypeHandler('.*?\\.broken$', () => { throw new Error('handler always fails'); });

    assert.throws(
        () => frame.write({ 'ok.md': 'fine', 'bad.broken': 'never lands' }),
        /bad\.broken/,
    );
});

test('a missing plugin dependency is not reported as a Jsonnet error', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));

    const frame = new SpellFrame({ baseDir: dir, renderPath: path.join(dir, 'render') });
    frame.loadedPlugins.set('@x/needs', { requires: ['@x/missing'] });
    frame.pluginRequirementErrors = frame.validatePluginRequirements();

    await assert.rejects(() => frame.renderString('{ a: 1 }'), (e) => {
        assert.match(e.message, /Dependency Error/);
        assert.doesNotMatch(
            e.message,
            /Jsonnet Evaluation Error/,
            'a precondition failure was labelled as an evaluation failure',
        );
        return true;
    });
});

test('a refused manifest leaves the previous render untouched', () => {
    // A run that refuses to write must not have already cleaned. Validation
    // therefore happens before cleanRenderPath(), not just before the writes --
    // otherwise a typo'd key deletes the last good output and replaces it with
    // nothing.
    const root = scratch();
    const renderPath = path.join(root, 'render');

    new SpellFrame({ renderPath }).write({ 'previous.md': 'still here' });

    assert.throws(
        () => new SpellFrame({ renderPath }).write({ '../nope.json': {} }),
        /resolves outside/,
    );

    assert.equal(
        fs.readFileSync(path.join(renderPath, 'previous.md'), 'utf-8'),
        'still here',
        'a refused write had already cleaned the previous render',
    );
});
