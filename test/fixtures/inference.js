'use strict';

/*
	Exported bare, so SpellCraft has to recover each parameter list from the
	function source. Every shape here is one the old parser got wrong.

	Note that native functions can only be *passed* primitives, which is why
	nothing here takes an object or an array.
*/

// Body contains parentheses -- the previous parser took the last ')' in the
// whole source and read parameter names out of the body.
exports.slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// No parentheses around the parameter at all.
exports.shout = word => `${word}!`;

// A default value containing a comma, a string and its own parentheses.
exports.join = function (text, separator = [',', ' '].join('')) {
	return text.split(' ').join(separator);
};

// Classic declaration with a body full of braces.
exports.repeat = function (text, times) {
	if (times < 1) { return ''; }

	return new Array(times).fill(text).join('');
};

exports.now = () => 'fixed';

exports.rest = (first, ...others) => [first, others.length];
