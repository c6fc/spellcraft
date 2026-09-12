'use strict';

/*
 * The CLI's error reporting, driven as a real process.
 *
 * These exist because the failure mode they cover is invisible from inside: a
 * command handler is async, and `.argv` hands back no promise, so a handler's
 * rejection escaped bin/spellcraft.js entirely -- the try/catch around setup
 * could only ever catch synchronous errors.
 *
 * The exit code was never the casualty; Node makes an unhandled rejection fatal,
 * so a failing command did exit 1. The output was. A user running a command that
 * failed got the command's own help text, then a raw stack trace, with no clear
 * statement of what went wrong -- measured, and asserted below.
 *
 * The obvious repair has its own failure: a .fail() that prints the handler's
 * error and returns, rather than rethrowing it, prints the message twice. So
 * these assert the shape of the output, not just that something was said.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'spellcraft.js');

// A directory with a package.json but no plugins, so the frame builds and the
// CLI is the only thing under test.
function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-cli-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '9.9.9' }));
    return dir;
}

function run(args, cwd) {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a failing command reports its message once, and exits non-zero', () => {
    const { code, out } = run(['generate', './does-not-exist.jsonnet'], project());

    assert.notStrictEqual(code, 0, 'a failed render must not exit 0');
    assert.match(out, /does-not-exist\.jsonnet does not exist/);

    // Exactly once. A .fail() that prints the handler's error and returns leaves
    // the rejection to Node as well, so the same line lands twice -- which is
    // what the obvious version of this fix does.
    const said = out.split('\n').filter((line) => line.includes('does not exist'));
    assert.strictEqual(said.length, 1, `reported ${said.length} times:\n${out}`);
});

test('a failing command does not print a stack trace or the help text', () => {
    const { out } = run(['generate', './does-not-exist.jsonnet'], project());

    assert.doesNotMatch(out, /\n\s+at /, 'a stack trace reached the user');
    assert.doesNotMatch(out, /Syntax: spellcraft/, 'the help text was dumped over the error');
});

test('a usage error still shows the help, and exits non-zero', () => {
    // .fail() replaces showHelpOnFail, so the help has to be printed by hand.
    // Easy to drop, and nothing else would notice.
    const { code, out } = run(['no-such-command'], project());

    assert.notStrictEqual(code, 0);
    assert.match(out, /Syntax: spellcraft/);
});

test('--help and --version succeed', () => {
    const dir = project();

    const help = run(['--help'], dir);
    assert.strictEqual(help.code, 0);
    assert.match(help.out, /Syntax: spellcraft/);

    const version = run(['--version'], dir);
    assert.strictEqual(version.code, 0);
    assert.match(version.out.trim(), /^\d+\.\d+\.\d+$/);
});

test('--version reports SpellCraft, not the consuming project', () => {
    // yargs' bare .version() walks up from wherever yargs itself resolved to and
    // takes the first package.json outside node_modules -- the *consumer's*, in a
    // real install. The fixture's version is 9.9.9 for exactly this assertion.
    const { out } = run(['--version'], project());
    const expected = require('../package.json').version;

    assert.strictEqual(out.trim(), expected);
    assert.notStrictEqual(out.trim(), '9.9.9', 'reported the consuming project version');
});
