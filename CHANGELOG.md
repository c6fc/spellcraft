# @c6fc/spellcraft

## 1.0.0

### Major Changes

- Jsonnet imports now resolve package names the way `require` does: the nearest
  `node_modules` first, then each ancestor. Previously only the working
  directory's `node_modules` was searched, so a plugin importing another
  plugin's `module.libsonnet` failed under npm workspaces, where dependencies
  are hoisted to the workspace root.

- Declare the plugin contract stable and release core 1.0.0.

  The `_spellcraft_metadata` shape, the `<package-name>:<export>` native
  namespacing, `functionContext`, and the `module.libsonnet` conventions have been
  stable in practice for some time. Core stayed on `0.x`, which forced every
  plugin to carry a hand-widened `>=0.2.0 <1.0.0` peer range: under semver a
  caret range on a `0.x` version reads every core minor as breaking, so the
  narrow form would have majored all eight plugins on every core release.

  At 1.0.0 that workaround is no longer needed. Plugins now declare an ordinary
  `^1.0.0` peer range and ordinary semver applies.

  Core also fixes parameter-name inference for functions exported bare rather than
  as `[fn, "arg1", "arg2"]`. The previous implementation searched for the last
  `)` in the whole function source, so any single-expression arrow function whose
  body contained parentheses had its parameter names read out of its body. Names
  are now recovered with a delimiter-aware scan, rest parameters are dropped
  rather than registered, and anything genuinely ambiguous — a destructured
  parameter, or minified source — raises at load time naming the export, instead
  of failing later at a call site in someone's manifest.
