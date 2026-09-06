'use strict';

/*
	The `assertions::` convention: a hidden top-level field is forced to
	evaluate before anything manifests, so a guard runs whether or not its
	return value is threaded into something visible.

	Before this, a hidden field was invisible to manifestation and nothing else
	forced it -- `{ assertions:: aws.assertIdentity(arn), "main.tf.json": {...} }`
	rendered `main.tf.json` and never once evaluated the assertion. That's the
	shape every test here reproduces: nothing downstream reads `assertions`.
*/

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

test('a passing assertions:: field does not block rendering', async () => {
	const spellframe = new SpellFrame();

	const rendered = await spellframe.renderString(
		`{ assertions:: (assert 1 + 1 == 2 : "unreachable"; true), "out.json": { ok: true } }`
	);

	assert.deepEqual(rendered, { 'out.json': { ok: true } });
});

test('a failing assertions:: field throws, though nothing references it', async () => {
	const spellframe = new SpellFrame();

	await assert.rejects(
		spellframe.renderString(
			`{ assertions:: (assert false : "custom guard failed"; true), "out.json": { ok: true } }`
		),
		/custom guard failed/
	);
});

test('assertions:: never appears in the rendered output', async () => {
	const spellframe = new SpellFrame();

	const rendered = await spellframe.renderString(
		`{ assertions:: "anything", "out.json": { ok: true } }`
	);

	assert.equal(Object.prototype.hasOwnProperty.call(rendered, 'assertions'), false);
});

test('a manifest with no assertions:: field renders exactly as before', async () => {
	const spellframe = new SpellFrame();

	const rendered = await spellframe.renderString(`{ "out.json": { ok: true } }`);

	assert.deepEqual(rendered, { 'out.json': { ok: true } });
});

test('the guard fires through render(file) too, not just renderString()', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-assertions-'));
	try {
		const manifestPath = path.join(dir, 'manifest.jsonnet');
		fs.writeFileSync(
			manifestPath,
			`{ assertions:: (assert false : "file guard failed"; true), "out.json": { ok: true } }`
		);

		const spellframe = new SpellFrame({ renderPath: path.join(dir, 'render') });

		await assert.rejects(spellframe.render(manifestPath), /file guard failed/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('an object combining several named checks runs all of them', async () => {
	const spellframe = new SpellFrame();

	await assert.rejects(
		spellframe.renderString(`{
			assertions:: {
				identity: (assert true : "unreachable"; "ok"),
				project: (assert false : "project check failed"; "ok"),
			},
			"out.json": { ok: true },
		}`),
		/project check failed/
	);
});
