'use strict';

/*
	Parameter-name inference for functions exported bare, exercised through the
	real plugin-loading path rather than against the helper directly.

	Jsonnet native functions are called by parameter name, so a misread name
	doesn't fail here -- it fails much later, at a call site in someone's
	manifest, pointing at the caller instead of the cause.
*/

const test = require('node:test');
const assert = require('node:assert');

const path = require('path');
const { SpellFrame } = require('../src/index.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'inference.js');

function frame() {
	const spellframe = new SpellFrame();
	spellframe.loadPlugin('fixture', FIXTURE);

	return spellframe;
}

test('infers parameters from a body containing parentheses', async () => {
	const rendered = await frame().renderString(
		`{ slug: std.native("fixture:slug")("Hello There World") }`
	);

	assert.equal(rendered.slug, 'hello-there-world');
});

test('infers a lone parameter written without parentheses', async () => {
	const rendered = await frame().renderString(
		`{ shout: std.native("fixture:shout")("hey") }`
	);

	assert.equal(rendered.shout, 'hey!');
});

test('infers around a default value containing commas and strings', async () => {
	const rendered = await frame().renderString(
		`{ joined: std.native("fixture:join")("a b", "-") }`
	);

	assert.equal(rendered.joined, 'a-b');
});

test('infers from a classic function declaration', async () => {
	const rendered = await frame().renderString(
		`{ repeated: std.native("fixture:repeat")("ab", 2) }`
	);

	assert.equal(rendered.repeated, 'abab');
});

test('handles a function with no parameters', async () => {
	const rendered = await frame().renderString(
		`{ now: std.native("fixture:now")() }`
	);

	assert.equal(rendered.now, 'fixed');
});

test('drops the rest parameter rather than naming it', async () => {
	const rendered = await frame().renderString(
		`{ rest: std.native("fixture:rest")("a") }`
	);

	// Jsonnet has no variadic call, so only the named leading parameters are
	// reachable. Registering "...others" as a parameter name would be worse.
	assert.deepEqual(rendered.rest, ['a', 0]);
});

test('refuses to guess at a destructured parameter', () => {
	const spellframe = new SpellFrame();

	assert.throws(
		() => spellframe.loadPlugin('destructured', path.join(__dirname, 'fixtures', 'destructured.js')),
		/Could not read the parameter names/,
		'expected an explicit failure rather than a nonsense parameter name'
	);
});
