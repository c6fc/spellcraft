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

// Same, but for the CLI half: writes the plugin's JS entry point under the given
// filename and asks for the commands it registers.
function generateCliFrom(entryFilename) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-docgen-cli-'));
	scratchDirs.push(dir);

	fs.writeFileSync(path.join(dir, entryFilename), `
		exports._spellcraft_metadata = {
			cliExtensions: (yargs) => {
				yargs.command('do-a-thing <name>', 'Does a thing', (y) => y, () => {});
			},
		};
	`);
	fs.writeFileSync(path.join(dir, 'README.md'),
		'<!-- SPELLCRAFT_DOCS_CLI_START -->\n<!-- SPELLCRAFT_DOCS_CLI_END -->\n');

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

test('documents CLI commands from a module.js entry point', () => {
	const readme = generateCliFrom('module.js');

	assert.match(readme, /do-a-thing <name>/);
	assert.match(readme, /Does a thing/);
});

test('documents CLI commands from an index.js entry point', () => {
	// A package built as a tree of nodes gives each node its own index.js and has
	// no module.js at all. Looking only for module.js silently emptied the CLI
	// section of every such README rather than documenting it.
	const readme = generateCliFrom('index.js');

	assert.match(readme, /do-a-thing <name>/);
	assert.match(readme, /Does a thing/);
});

test('a doc comment with no function after it does not swallow the source', () => {
	// The comment capture was lazy but *unbounded*, so it did not stop at '*/'.
	// A documented member with no parentheses -- an ordinary constant -- could
	// not complete the match there, so the engine extended the comment past its
	// own terminator to the next member that did have them. Two members then
	// collapsed into one entry, with the raw Jsonnet between them printed as
	// documentation prose, into a README that gets published.
	const readme = generateFrom(`{
	/**
	 * A documented constant.
	 * @returns {string} the version
	 */
	version:: "1.0.0",

	/**
	 * Greets someone.
	 * @param {string} who - the name
	 * @returns {string} a greeting
	 */
	greet(who):: "hello %s" % who,
}`);

	assert.match(readme, /### `greet\(who\)`/);
	assert.match(readme, /Greets someone\./);

	// None of the constant's source, and none of its @returns, attributed to greet.
	assert.doesNotMatch(readme, /version:: "1\.0\.0"/);
	assert.doesNotMatch(readme, /A documented constant/);
	assert.doesNotMatch(readme, /the version/);
});

test('the skipped doc comment is reported, with a line number', () => {
	const said = [];
	const warn = console.warn;
	console.warn = (message) => said.push(String(message));

	try {
		generateFrom(`{
	/**
	 * A documented constant.
	 */
	version:: "1.0.0",
}`);
	} finally {
		console.warn = warn;
	}

	// Otherwise the convention stays folklore: the plugin tree already works
	// around this by writing line comments on parenless members, and nothing
	// tells the next author that rule exists.
	assert.ok(
		said.some((line) => /Skipped the doc comment at module\.libsonnet:2/.test(line)),
		`nothing was reported:\n${said.join('\n')}`
	);
});
