# @c6fc/spellcraft

## 2.0.0

### Major Changes

- Remove the `assertions::` convention and the two identity helpers.

  `render()` and `renderString()` no longer force a hidden top-level `assertions::`
  field before manifesting — a manifest that relies on that will now render
  without evaluating it. `aws.auth.assertIdentity()` and
  `gcp.auth.assertProject()` are gone; `getCallerIdentity()` and `getProjectId()`
  remain.

### Patch Changes

- Report command failures properly on the CLI.

  Command handlers are async, but `bin/spellcraft.js` read `.argv`, which hands
  back no promise — so a handler's rejection escaped the try/catch around setup
  entirely. A command that failed printed its own help text, then a raw stack
  trace, with no clear statement of what went wrong. It now parses with
  `parseAsync()` behind a `.fail()` handler that rethrows a handler's error and
  keeps the help for genuine usage errors, so a failure is one line saying what
  broke. Exit codes are unchanged: a failing command exited 1 before and exits 1
  now.

- `spellcraft --version` reports SpellCraft's version.

  yargs' bare `.version()` walks up from wherever yargs itself resolved to and
  takes the first `package.json` outside `node_modules` — which in an installed
  project is the *consumer's* `package.json`. So `spellcraft --version` printed
  the version of whatever project it was run in. It is now pinned to core's own.

- The manifest contract is enforced: filename -> content, inside `renderPath`.

  A key containing `..` used to write outside the render directory, and then be
  recorded in the render manifest — so the *next* run's clean resolved the same
  `..` and deleted a file SpellCraft never wrote. Keys are now resolved before
  anything is written *or cleaned*, so a manifest naming one is refused with the
  previous render left exactly as it was, and `cleanBeforeRender` refuses to
  follow such a path out of `renderPath` even from a manifest an older version
  left behind. To write outside `render/`, or to set a file mode, use a Terraform
  `local_file` resource — the error says so.

  A key naming a subdirectory now creates it instead of failing with ENOENT.

- A failed write fails the run.

  `write()` caught per file, logged, and carried on, so `spellcraft generate`
  printed "Generation complete." and exited 0 having written nine of ten files.
  It now throws naming what failed — after writing the render manifest, so what
  did land is still recorded and cleanable.

- A manifest must evaluate to an object.

  An array satisfied `typeof === 'object'` and was walked by index, producing
  files called `0` and `1`; anything else wrote nothing and said nothing. Both
  are now one error naming what the manifest actually produced.

- An unsatisfied plugin dependency is no longer labelled a Jsonnet error.

  It is a precondition, checked before evaluation rather than inside it, so the
  message no longer sends you to inspect a manifest that is fine.

- Plugin discovery is consistent across both paths.

  `loadPluginsFromDependencies()` accepted either `"spellcraft": true` or the
  `spellcraft-module` keyword; `loadPluginsRecursively()` accepted only the
  former. A keyword-only plugin was therefore loaded at the top level and never
  recursed into, so its own plugin dependencies went missing. Both now share one
  predicate, and both report skips under `SPELLCRAFT_DEBUG`.

- `--skip-module-cleanup` does something.

  `spellcraft_modules/*.js` are compiled into a generated `.spellcraft/modules`
  aggregate for Jsonnet to import, and nothing ever removed it — while the flag
  meant to keep it set a property `SpellFrame` did not have. The aggregate is now
  cleaned after every evaluation, including a failed one, and `--skip-module-cleanup`
  keeps it. That is what the flag is for: a module that throws on load is only
  *warned* about, so the manifest fails later with `field does not exist`, and the
  aggregate is where you see that the module contributed nothing. The aggregate is
  regenerated per evaluation rather than once per frame, so a module edited between
  two renders on the same frame is picked up.

- A missing plugin dependency no longer breaks `--help`.

  `validatePluginRequirements()` threw from the `SpellFrame` constructor, which
  runs before any command does — so a project with one plugin whose `requires`
  was unsatisfied could not run `spellcraft --help` or `spellcraft doc` to work
  out what it had. The check now collects its problems at construction and raises
  them from `init()` and before every evaluation, so the commands that don't
  render still work and anything that renders fails with the same message.

- A native function's event fires on every call.

  `emit()` sat below the memoisation check, so a `<plugin>:<fn>` listener saw
  only the first call for a given set of arguments — silently useless for
  counting or tracing. Memoisation itself is unchanged: the function still runs
  once per `(name, args)` within an evaluation.

- The native memo cache no longer leaks between renders.

  It lived for the life of the frame, so a second `render()` on a reused frame
  replayed the first one's answers, including whatever a live API returned then.
  It is now cleared per evaluation. Within one evaluation memoisation is
  unchanged, which is load-bearing — `gcp.terraform`'s `googleOrgProject()`
  depends on it.

## 1.0.0

### Major Changes

- Emit verbatim text. `.md` and `.txt` now have default handlers that write a
  string through untouched, and plugins can register handlers of their own for
  other text formats.

  Previously every default handler and the no-match fallback ran
  `JSON.stringify`, so a Markdown file arrived on disk quoted with its newlines
  as literal `\n` — there was no way to emit raw text at all.

  The three existing patterns also had their escaping corrected: written as JS
  strings, `'.*?\.json$'` reached `RegExp` as `.*?.json$`, where the dot was a
  wildcard rather than a literal.

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
