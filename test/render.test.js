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

test('init() across multiple SpellFrames never overlaps', async () => {
	let active = 0;
	let maxActive = 0;

	function frameWithSlowInit(delayMs) {
		const spellframe = new SpellFrame();
		spellframe.initFn.push(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, delayMs));
			active--;
		});
		return spellframe;
	}

	const frames = [30, 10, 50, 5].map(frameWithSlowInit);
	await Promise.all(frames.map(f => f.init()));

	assert.equal(maxActive, 1, 'two frames\' init() bodies ran at the same time');
});

test('one frame\'s init() and another frame\'s evaluation never overlap', async () => {
	let active = 0;
	let maxActive = 0;

	async function occupy(ms) {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise(resolve => setTimeout(resolve, ms));
		active--;
	}

	const slowIniter = new SpellFrame();
	slowIniter.initFn.push(() => occupy(30));

	const evaluator = new SpellFrame();
	evaluator.addNativeFunction('slow', () => occupy(20));

	// init() runs on one frame, renderString() (evaluation only, no init) on
	// the other -- if these ever run at the same time, a plugin's init hook
	// (which might mutate shared state a native call also reads, e.g.
	// gcp-auth's credentials) could race with a completely unrelated frame's
	// evaluation.
	await Promise.all([
		slowIniter.init(),
		evaluator.renderString('{ ok: std.native("slow")() }'),
	]);

	assert.equal(maxActive, 1, 'a different frame\'s init() and evaluation ran at the same time');
});
