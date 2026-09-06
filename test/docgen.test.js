'use strict';

/*
	Signature parsing for the README generator. A default value may itself be a
	function call, so the argument list cannot simply run to the first ')'.
*/

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DocGenerator = require('../src/doc-generator.js');

const scratchDirs = [];

function generateFrom(libsonnet) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-docgen-'));
	scratchDirs.push(dir);

	fs.writeFileSync(path.join(dir, 'module.libsonnet'), libsonnet);
	fs.writeFileSync(path.join(dir, 'README.md'),
		'<!-- SPELLCRAFT_DOCS_API_START -->\n<!-- SPELLCRAFT_DOCS_API_END -->\n');

	new DocGenerator(dir).generate();

	return fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
}

test.after(() => {
	for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps a default value that calls a function intact', () => {
	const readme = generateFrom(`{
	/**
	 * Calls an API.
	 */
	api(fullpath, params={ project: gcp.getProjectId() }):: null,
}`);

	assert.match(readme, /### `api\(fullpath, params=\{ project: gcp\.getProjectId\(\) \}\)`/);
});

test('handles a plain signature and a visible member', () => {
	const readme = generateFrom(`{
	/**
	 * One.
	 */
	first(a, b):: null,

	/**
	 * Two, a visible field.
	 */
	second(name, options = {}): null,
}`);

	assert.match(readme, /### `first\(a, b\)`/);
	assert.match(readme, /### `second\(name, options = \{\}\)`/);
});

test('handles a member with no arguments', () => {
	const readme = generateFrom(`{
	/**
	 * Nothing in, something out.
	 */
	getProjectId():: null,
}`);

	assert.match(readme, /### `getProjectId\(\)`/);
});
