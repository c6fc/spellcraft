#! /usr/bin/env node

const fs = require('fs');
const { SpellFrame } = require('./index.js');

const spell = new SpellFrame({
	renderPath: './render',
	cleanBeforeRender: true
});

(async () => {

	testBootstrap = await spell.renderString(`local spellcraft = import 'spellcraft'; { test: spellcraft.path() }`);
	console.log(testBootstrap);

})();