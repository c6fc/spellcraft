'use strict';

/*
	File emission: which serialiser a filename picks, and what reaches disk.

	The case that matters most is verbatim text. Before .md and .txt had
	handlers, a string value fell through to the default handler and was
	JSON.stringify'd — a Markdown file arrived quoted, with its newlines as
	literal backslash-n.
*/

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

const scratchDirs = [];

function scratch() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-write-'));
	scratchDirs.push(dir);

	return dir;
}

function writeInto(files, options = {}) {
	const renderPath = scratch();

	new SpellFrame({ renderPath, ...options }).write(files);

	return (name) => fs.readFileSync(path.join(renderPath, name), 'utf-8');
}

test.after(() => {
	for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('writes a markdown string byte-for-byte', () => {
	const source = '# Generated\n\nDo not edit.\n';
	const read = writeInto({ 'README.md': source });

	assert.equal(read('README.md'), source);
});

test('writes a plain text string byte-for-byte', () => {
	const source = 'first\nsecond\n';
	const read = writeInto({ 'notes.txt': source });

	assert.equal(read('notes.txt'), source);
});

test('still serialises objects to JSON', () => {
	const read = writeInto({ 'main.tf.json': { resource: { aws_s3_bucket: { a: {} } } } });

	assert.deepEqual(JSON.parse(read('main.tf.json')), { resource: { aws_s3_bucket: { a: {} } } });
});

test('serialises objects to YAML', () => {
	const read = writeInto({ 'values.yaml': { replicas: 3 } });

	assert.match(read('values.yaml'), /^replicas: 3$/m);
});

test('a non-string in a verbatim slot still lands as JSON, not [object Object]', () => {
	const read = writeInto({ 'notes.md': { a: 1 } });

	assert.deepEqual(JSON.parse(read('notes.md')), { a: 1 });
});

test('an extension with no registered handler still writes a string verbatim', () => {
	const source = '#!/bin/bash\necho hi\n';
	const read = writeInto({ 'connect.sh': source });

	assert.equal(read('connect.sh'), source);
});

test('an extension with no registered handler still falls back to JSON for a non-string', () => {
	const read = writeInto({ 'data.unknownext': { a: 1 } });

	assert.deepEqual(JSON.parse(read('data.unknownext')), { a: 1 });
});

test('handler patterns match a literal dot, not any character', () => {
	// '.*?\.json$' as a JS string reaches RegExp as '.*?.json$', so this name
	// would wrongly pick the JSON handler and arrive quoted. The default
	// handler is verbatim too now, so a collision with '.txt$' would no
	// longer be visible in the output -- '.json$' still is, since its
	// handler always stringifies where the default only does that for
	// non-strings.
	const read = writeInto({ 'notesXjson': 'plain' });

	assert.equal(read('notesXjson'), 'plain');
});

test('a plugin handler for .tf does not capture .tf.json', () => {
	const renderPath = scratch();
	const frame = new SpellFrame({ renderPath });

	frame.addFileTypeHandler('.*?\\.tf$', (content) => content);
	frame.write({
		'legacy.tf': 'resource "aws_s3_bucket" "a" {}\n',
		'main.tf.json': { resource: {} }
	});

	const read = (name) => fs.readFileSync(path.join(renderPath, name), 'utf-8');

	assert.equal(read('legacy.tf'), 'resource "aws_s3_bucket" "a" {}\n');
	assert.deepEqual(JSON.parse(read('main.tf.json')), { resource: {} });
});

test('cleanBeforeRender removes a stale file whose extension has a handler, on a directory with no manifest yet', () => {
	const renderPath = scratch();
	fs.writeFileSync(path.join(renderPath, 'stale.md'), 'old');

	new SpellFrame({ renderPath }).write({ 'fresh.md': 'new' });

	assert.equal(fs.existsSync(path.join(renderPath, 'stale.md')), false);
	assert.equal(fs.readFileSync(path.join(renderPath, 'fresh.md'), 'utf-8'), 'new');
});

test('cleanBeforeRender only removes what SpellCraft itself wrote, once a manifest exists', () => {
	const renderPath = scratch();

	// First write establishes the manifest: it produced first.md, so a later
	// write is entitled to clean first.md up once it's no longer produced.
	new SpellFrame({ renderPath }).write({ 'first.md': 'one' });

	// A file dropped in by hand between runs -- never in any manifest, and
	// this is the exact shape of the footgun: it shares an extension with
	// something SpellCraft generates, but SpellCraft never wrote it.
	fs.writeFileSync(path.join(renderPath, 'manual.md'), 'hand-written');

	new SpellFrame({ renderPath }).write({ 'second.md': 'two' });

	assert.equal(fs.existsSync(path.join(renderPath, 'first.md')), false, 'expected the previous manifest entry to be cleaned up');
	assert.equal(fs.readFileSync(path.join(renderPath, 'manual.md'), 'utf-8'), 'hand-written', 'expected the hand-written file to survive since SpellCraft never wrote it');
	assert.equal(fs.readFileSync(path.join(renderPath, 'second.md'), 'utf-8'), 'two');
});

test('the manifest only records files that were actually written', () => {
	const renderPath = scratch();
	const frame = new SpellFrame({ renderPath });

	frame.addFileTypeHandler('.*?\\.broken$', () => { throw new Error('handler always fails'); });

	// A partial write is a failed run -- but the manifest still has to record
	// what did land, or the next clean cannot remove it. Both halves matter, and
	// the throw comes after the manifest is written for exactly that reason.
	assert.throws(() => frame.write({ 'ok.md': 'fine', 'bad.broken': 'never lands' }), /bad\.broken/);

	const manifest = JSON.parse(fs.readFileSync(frame.manifestPath, 'utf-8'));
	assert.deepEqual(manifest, ['ok.md']);
	assert.equal(fs.readFileSync(path.join(renderPath, 'ok.md'), 'utf-8'), 'fine');
});
