'use strict';

/*
 * What a native function is allowed to hand back.
 *
 * The layer below SpellCraft does not defend itself here. A native returning a
 * cyclic object takes the whole process down with SIGSEGV -- no exception, no
 * message, no partial output -- and that is reproducible against
 * @hanazuki/node-jsonnet directly, with SpellCraft nowhere in the picture. A
 * non-finite number is not much better: the bridge writes `nan`/`inf` into its
 * own output text, and the failure arrives as a JSON parse error quoting a
 * fragment of generated JSON, which reads as a bug in the manifest.
 *
 * addNativeFunction() is the only place holding the user's function, so the
 * check lives there. None of these inputs is exotic -- 0/0, a BigInt from a byte
 * count or a database driver, a cyclic object from an SDK response.
 *
 * Note what these tests are really asserting: that the process is still alive to
 * run the next one. A regression here does not fail, it crashes.
 */

const test = require('node:test');
const assert = require('node:assert');

const { SpellFrame } = require('../src/index.js');

function frameWith(name, fn) {
    const frame = new SpellFrame({ baseDir: __dirname });
    frame.addNativeFunction(name, fn);
    return frame;
}

test('a cyclic return is named, not a segfault', async () => {
    const frame = frameWith('cyc', () => {
        const a = {};
        a.self = a;
        return a;
    });

    await assert.rejects(
        () => frame.renderString('{ "r.json": { v: std.native("cyc")() } }'),
        /native 'cyc' returned a value that cannot cross into Jsonnet[\s\S]*circular/
    );
});

test('a non-finite number is named, including one nested inside an object', async () => {
    const top = frameWith('ratio', () => 0 / 0);

    await assert.rejects(
        () => top.renderString('{ "r.json": { v: std.native("ratio")() } }'),
        /native 'ratio'[\s\S]*non-finite number \(NaN\)/
    );

    // JSON.stringify(NaN) is "null", so a check on the returned value alone
    // catches the top-level case and misses this one entirely.
    const nested = frameWith('deep', () => ({ a: { b: Infinity } }));

    await assert.rejects(
        () => nested.renderString('{ "r.json": { v: std.native("deep")() } }'),
        /native 'deep'[\s\S]*non-finite number \(Infinity\)/
    );
});

test('a BigInt is named rather than silently becoming null', async () => {
    const frame = frameWith('bytes', () => 10n);

    await assert.rejects(
        () => frame.renderString('{ "r.json": { v: std.native("bytes")() } }'),
        /native 'bytes'[\s\S]*BigInt/
    );
});

test('an async native is checked on what it resolves to', async () => {
    const frame = frameWith('later', async () => {
        const a = {};
        a.self = a;
        return a;
    });

    // Stringifying the promise itself proves nothing -- it serialises to {} --
    // so the check has to ride on .then(), which is the value the bridge awaits.
    await assert.rejects(
        () => frame.renderString('{ "r.json": { v: std.native("later")() } }'),
        /native 'later' returned a value that cannot cross into Jsonnet[\s\S]*circular/
    );
});

test('the values that were always fine still are', async () => {
    const frame = new SpellFrame({ baseDir: __dirname });

    frame.addNativeFunction('str', () => 'hello');
    frame.addNativeFunction('num', () => 42);
    frame.addNativeFunction('obj', () => ({ a: [1, 'x', null, true], b: { c: 0 } }));
    frame.addNativeFunction('when', () => new Date(0));
    frame.addNativeFunction('soon', async () => 42);

    const rendered = await frame.renderString(`{
        "r.json": {
            str: std.native("str")(),
            num: std.native("num")(),
            obj: std.native("obj")(),
            when: std.native("when")(),
            soon: std.native("soon")(),
        }
    }`);

    assert.deepStrictEqual(rendered['r.json'], {
        str: 'hello',
        num: 42,
        obj: { a: [1, 'x', null, true], b: { c: 0 } },
        when: '1970-01-01T00:00:00.000Z',
        soon: 42,
    });
});

test('the memo still holds, and the check does not defeat it', async () => {
    let calls = 0;

    const frame = new SpellFrame({ baseDir: __dirname });
    frame.addNativeFunction('counted', () => { calls += 1; return calls; });

    // Same (name, args) twice in one evaluation: the check must not defeat the
    // memoisation that gcp.terraform's googleOrgProject() depends on.
    const rendered = await frame.renderString(
        '{ "r.json": { a: std.native("counted")(), b: std.native("counted")() } }'
    );

    assert.deepStrictEqual(rendered['r.json'], { a: 1, b: 1 });
    assert.strictEqual(calls, 1, 'the native ran twice for one (name, args) pair');
});
