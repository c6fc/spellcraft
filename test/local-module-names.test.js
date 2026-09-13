'use strict';

/*
 * Names crossing from JavaScript into the generated spellcraft_modules aggregate.
 *
 * Three positions carry a name over that boundary -- the module's *filename*,
 * each *export name*, and each *parameter name* -- and all three used to be
 * interpolated as bare Jsonnet identifiers. So an ordinary
 * `spellcraft_modules/my-utils.js` produced an aggregate that did not parse, the
 * loader printed `[+] Loaded ...` immediately before emitting it, and because
 * the aggregate is a single object literal, one bad filename took down every
 * *other* local module in the project with `field does not exist: <name>`.
 *
 * Jsonnet accepts any string as a field name, so the first two are fixed by
 * quoting. A parameter cannot be quoted, so that one has to be refused -- and
 * the check that was already there tested for a *JavaScript* identifier, which
 * happily accepts `self`, `local`, `error` and the rest of Jsonnet's keywords.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

// A project whose spellcraft_modules holds exactly the files given.
function project(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-modnames-'));

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    fs.mkdirSync(path.join(dir, 'spellcraft_modules'));

    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'spellcraft_modules', name), body);
    }

    return dir;
}

test('a filename that is not a Jsonnet identifier still works', async () => {
    const dir = project({ 'my-utils.js': 'exports.slugify = (input) => input.toLowerCase();\n' });
    const frame = new SpellFrame({ baseDir: dir });

    const rendered = await frame.renderString(
        '{ said: (import "modules")["my-utils"].slugify("HELLO") }'
    );

    assert.strictEqual(rendered.said, 'hello');
});

test('an export name that is not a Jsonnet identifier still works', async () => {
    const dir = project({ 'utils.js': 'exports["get-thing"] = (input) => `got ${input}`;\n' });
    const frame = new SpellFrame({ baseDir: dir });

    const rendered = await frame.renderString(
        '{ said: (import "modules").utils["get-thing"]("x") }'
    );

    assert.strictEqual(rendered.said, 'got x');
});

test('a Jsonnet keyword as a filename or an export name is fine too', async () => {
    // `local`, `error`, `self`, `import` -- all legal JS, all reserved in
    // Jsonnet, and all reachable through a quoted field name.
    const dir = project({ 'local.js': 'exports.error = () => "still here";\n' });
    const frame = new SpellFrame({ baseDir: dir });

    const rendered = await frame.renderString(
        '{ said: (import "modules")["local"]["error"]() }'
    );

    assert.strictEqual(rendered.said, 'still here');
});

test('one awkwardly-named module no longer takes the others down with it', async () => {
    // The aggregate is one object literal, so a single unparseable field name
    // used to be a STATIC ERROR for the whole file -- and the symptom was
    // `field does not exist` naming a module that was perfectly fine.
    const dir = project({
        '2fa.js': 'exports.code = () => "123456";\n',
        'aws.helpers.js': 'exports.region = () => "us-west-2";\n',
        'fine.js': 'exports.ok = () => true;\n',
    });

    const frame = new SpellFrame({ baseDir: dir });
    const modules = '(import "modules")';

    const rendered = await frame.renderString(`{
        code: ${modules}["2fa"].code(),
        region: ${modules}["aws.helpers"].region(),
        ok: ${modules}.fine.ok(),
    }`);

    assert.deepStrictEqual(rendered, { code: '123456', region: 'us-west-2', ok: true });
});

test('a parameter named after a Jsonnet keyword is refused, by name, at load', async () => {
    // Not quotable, so this is the one position that has to be rejected. It is
    // also the subtlest: `(error) => error` is ordinary JavaScript.
    const dir = project({ 'go.js': 'exports.go = (error) => error;\n' });

    assert.throws(
        () => new SpellFrame({ baseDir: dir }),
        /go\.js:go.*parameter named 'error'.*Jsonnet keyword/s
    );
});

test('the explicit [fn, "arg"] form is checked too', async () => {
    // The documented escape hatch is from *inference*, not from Jsonnet's
    // grammar -- it used to be unchecked in both directions.
    const hyphen = project({ 'go.js': 'exports.go = [(x) => x, "x-y"];\n' });

    assert.throws(
        () => new SpellFrame({ baseDir: hyphen }),
        /'x-y' is not a plain name/
    );

    const keyword = project({ 'go.js': 'exports.go = [(x) => x, "self"];\n' });

    assert.throws(
        () => new SpellFrame({ baseDir: keyword }),
        /parameter named 'self'.*Jsonnet keyword/s
    );
});

test('a failure inside the aggregate keeps the aggregate', async () => {
    // The error cites `.spellcraft/modules:<line>`, and cleanup runs in a
    // finally -- so the file the message tells you to read was deleted on the
    // way out, and you had to already know --skip-module-cleanup exists to see
    // it. A module that is *syntactically* fine but whose Jsonnet is not is the
    // remaining way to get there.
    const dir = project({ 'utils.js': 'exports.nope = [(x) => x, "ok"];\n' });
    const frame = new SpellFrame({ baseDir: dir });

    // Overwrite the aggregate mid-flight is not possible, so break it the way
    // the loader used to: write an unparseable aggregate and evaluate against it.
    frame.loadLocalMagicModules = function () {
        this.generatedModulePath = path.join(dir, '.spellcraft', 'modules');
        fs.mkdirSync(path.dirname(this.generatedModulePath), { recursive: true });
        fs.writeFileSync(this.generatedModulePath, '{\n  my-utils: {}\n}');
    };

    await assert.rejects(() => frame.renderString('{ v: (import "modules") }'));

    assert.strictEqual(
        fs.existsSync(path.join(dir, '.spellcraft', 'modules')),
        true,
        'the file the error points into was deleted before anyone could read it'
    );
});
