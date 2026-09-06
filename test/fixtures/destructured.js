'use strict';

// Exported bare with a destructured parameter, which has no name Jsonnet could
// call it by. SpellCraft should say so rather than register something broken.
exports.combine = ({ a, b }) => a + b;
