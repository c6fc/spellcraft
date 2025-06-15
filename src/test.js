#! /usr/bin/env node

const fs = require('fs');
const { SpellFrame } = require('./index.js');

const sonnetry = new SpellFrame({
	renderPath: './render',
	cleanBeforeRender: true
});

(async () => {

	testBootstrap = sonnetry.render(`local spellcraft = import 'spellcraft'; { test: spellcraft.path() }`);
	console.log(testBootstrap);

})();