'use strict';

/*
	A plugin's own `module.libsonnet` can `import` another package by name, the
	same way its `module.js` `require()`s one. `require()` resolves that by
	walking up from the plugin's *real* location on disk, so it works even when
	the plugin is only reachable through a symlink (a workspace, `file:`,
	`npm link`) and the dependency is never hoisted into the consumer's own
	node_modules. Jsonnet's `import` had no equivalent: jpath was built once,
	from the consumer's own node_modules ancestry, so a plugin's own import
	resolved only when the consumer happened to carry that dependency too.

	This fixture reproduces the shape exactly: a real symlink standing in for a
	`file:` dependency, and a second package reachable only from the *target*
	of that symlink's own node_modules -- never from the consumer's.
*/

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('../src/index.js');

function buildFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-jpath-'));

	const consumerDir = path.join(root, 'consumer');
	const vendorDir = path.join(root, 'vendor');
	const pluginADir = path.join(vendorDir, 'plugin-a');
	const pluginBDir = path.join(vendorDir, 'node_modules', '@acme', 'plugin-b');
	const linkDir = path.join(consumerDir, 'node_modules', '@acme');

	fs.mkdirSync(pluginADir, { recursive: true });
	fs.mkdirSync(pluginBDir, { recursive: true });
	fs.mkdirSync(linkDir, { recursive: true });

	// plugin-b is only ever reachable from vendor/node_modules -- never from
	// the consumer's -- so it stands in for a transitive dependency that a
	// linked install doesn't hoist.
	fs.writeFileSync(path.join(pluginBDir, 'module.libsonnet'), '{ value: "b" }');

	// plugin-a is what the consumer actually depends on, as a symlink -- what
	// `file:`/workspace/`npm link` installs look like on disk.
	fs.writeFileSync(path.join(pluginADir, 'module.js'), 'module.exports = {};');
	fs.writeFileSync(
		path.join(pluginADir, 'module.libsonnet'),
		'import "@acme/plugin-b/module.libsonnet"'
	);
	fs.symlinkSync(pluginADir, path.join(linkDir, 'plugin-a'), 'dir');

	return { root, consumerDir };
}

test('a plugin\'s own import resolves through its real node_modules ancestry, not just the consumer\'s', async () => {
	const { root, consumerDir } = buildFixture();
	try {
		const spellframe = new SpellFrame({ baseDir: consumerDir });
		spellframe.loadPlugin(
			'@acme/plugin-a',
			path.join(consumerDir, 'node_modules', '@acme', 'plugin-a', 'module.js')
		);

		const rendered = await spellframe.renderString(
			'import "@acme/plugin-a/module.libsonnet"'
		);

		assert.equal(rendered.value, 'b');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('baseDir is captured per instance, not frozen at module load', () => {
	const { root, consumerDir } = buildFixture();
	try {
		const spellframe = new SpellFrame({ baseDir: consumerDir });
		assert.equal(spellframe.baseDir, consumerDir);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
