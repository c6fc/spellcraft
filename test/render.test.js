'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SpellFrame } = require('../src/index.js');

test('evaluates a snippet through the built-in library', async () => {
	const spellframe = new SpellFrame();

	const rendered = await spellframe.renderString(
		`local spellcraft = import "spellcraft"; { path: spellcraft.path() }`
	);

	assert.equal(rendered.path, process.cwd());
});

test('envvar reports false for an unset variable', async () => {
	const spellframe = new SpellFrame();

	const rendered = await spellframe.renderString(
		`local spellcraft = import "spellcraft"; { set: spellcraft.envvar("SPELLCRAFT_TEST_UNSET_VARIABLE") }`
	);

	assert.equal(rendered.set, false);
});

test('memoises a native function per argument list', async () => {
	const spellframe = new SpellFrame();

	let calls = 0;
	spellframe.addNativeFunction('counter', () => ++calls);

	const rendered = await spellframe.renderString(
		`{ first: std.native("counter")(), second: std.native("counter")() }`
	);

	assert.equal(rendered.first, 1);
	assert.equal(rendered.second, 1, 'expected the second call to be served from cache');
	assert.equal(calls, 1);
});
