# SpellCraft

Configuration that discovers its own context.

SpellCraft evaluates [Jsonnet](https://jsonnet.org/) with Node.js reachable from
inside it, then writes the result to disk. Because evaluation can call live APIs,
a configuration can work out its own account IDs, existing buckets and enabled
services instead of having those values pasted into it.

It emits ordinary machine-readable files — most often Terraform JSON — and owns
no state of its own.

[![NPM Version](https://img.shields.io/npm/v/@c6fc/spellcraft.svg)](https://www.npmjs.com/package/@c6fc/spellcraft)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft.svg)](https://github.com/c6fc/spellcraft/blob/main/LICENSE)

Full documentation: **[spellcraft.io](https://spellcraft.io)**

## Requirements

Node.js 18 or newer, and a C++ toolchain — Jsonnet is compiled from source when
`@hanazuki/node-jsonnet` installs. On Debian or Ubuntu that means
`build-essential` and `cmake`; on macOS, the Xcode command line tools. A wall of
`node-gyp` output during install is almost always this.

## Quick start

```bash
npm init spellcraft my-infra
cd my-infra
npm run gen
```

Or add it to a project you already have:

```bash
npm install --save @c6fc/spellcraft
npm install --save @c6fc/spellcraft-plugins
```

Write a `manifest.jsonnet`. Its top-level keys are filenames, and their values
are the file contents:

```jsonnet
local spellcraft = import "spellcraft";
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

// envvar() returns false when a variable is unset, which makes defaulting
// an ordinary conditional.
local region =
	local declared = spellcraft.envvar("AWS_REGION");
	if declared == false then "us-east-1" else declared;

{
	"identity.json": aws.getCallerIdentity(),

	"config.yaml": {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: { name: "my-app-config" },
		data: {
			region: region,
			account: aws.getCallerIdentity().Account,
		},
	},
}
```

Render it:

```bash
npx spellcraft generate manifest.jsonnet

# [+] Evaluating Jsonnet file: /path/to/manifest.jsonnet
# [+] Writing files to: ./render
#   -> identity.json
#   -> config.yaml
# [+] Generation complete.
```

The account number in `config.yaml` was fetched from STS while the Jsonnet was
being evaluated. Nobody typed it, and nobody has to update it when you change
accounts.

## Three kinds of import

```jsonnet
local spellcraft = import "spellcraft";                              // built-ins
local modules = import "modules";                                    // spellcraft_modules/
local plugins = import "@c6fc/spellcraft-plugins/module.libsonnet";  // installed plugins

{
	"context.json": {
		renderedFrom: spellcraft.path(),
		name: modules.util.slug("My First Spell"),
		account: plugins.aws.auth.getCallerIdentity().Account,
	},
}
```

`"spellcraft"` is the built-in library, and is deliberately small:

| | |
|---|---|
| `spellcraft.envvar(name)` | the environment variable, or `false` if unset |
| `spellcraft.path()` | the directory of the manifest being rendered |

Plugins are imported by package name. SpellCraft finds them by walking your
project's dependencies for packages flagged `"spellcraft": true`, so installing
one is the whole of the setup — there is no registry and nothing to register.

## Local modules

For logic that belongs to one project and doesn't warrant a package, drop a
`.js` file into `spellcraft_modules/`. Its exports become callable from Jsonnet,
namespaced by filename:

```javascript
// spellcraft_modules/util.js
exports.slug = [(text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'text'];

exports.replicasFor = [(environment) => environment === 'prod' ? 3 : 1, 'environment'];
```

```jsonnet
local modules = import "modules";

{
	"app.json": {
		name: modules.util.slug("My First Spell"),
		replicas: modules.util.replicasFor("prod"),
	},
}
```

Export either a bare function or `[fn, ...parameterNames]`. Prefer the explicit
form: Jsonnet calls native functions by parameter name, so the names have to be
recovered from the function source otherwise, and that cannot work for minified
or destructured parameters. SpellCraft raises at load time when it can't read
them rather than registering something that fails later at a call site.

## Output

Each top-level key is written into `render/`, serialised by the first handler
whose pattern matches the filename:

| Pattern | Output |
|---|---|
| `.json` | pretty-printed JSON |
| `.yaml`, `.yml` | YAML, four-space indent |
| `.md`, `.txt` | verbatim — a string is written through untouched |
| anything else | verbatim — same as `.md`/`.txt`; a non-string still falls back to pretty-printed JSON |

Plugins register their own through `fileTypeHandlers`;
`@c6fc/spellcraft-plugins`'s terraform node claims `.tf`, which is how hand-written HCL can be
carried into a spell alongside generated configuration.

Before writing, SpellCraft removes whatever its own previous `write()` put
there — not everything in `render/` that happens to match a registered
pattern — so a renamed output cannot linger, and a hand-written file that
merely shares an extension with something SpellCraft generates is never
touched. The list of what was written lives at
`render/.spellcraft/manifest.json`; each removal is logged (`  -x name`), and
nothing is deleted silently. Terraform only reads files directly inside
`render/`, not subdirectories, so this is invisible to it.

The one exception is a `render/` directory with no manifest yet — freshly
created, or left over from before this existed — where SpellCraft falls back
to the old sweep-by-registered-pattern once, so an upgrade doesn't strand
old output forever. Every write after that first one is manifest-driven.

## CLI

```
spellcraft generate <filename>   Evaluate a manifest and write the result
spellcraft doc                   Regenerate this package's README API reference
spellcraft --help                List every command, plugins included
```

`generate` takes the same external-variable flags `jsonnet(1)` does, bound to
`std.extVar`, each repeatable:

```
spellcraft generate main.jsonnet --ext-str stage=prod --ext-code replicas=2+1
```

`--ext-str` binds a string; `--ext-code` binds a Jsonnet expression. The
difference matters — the value of `--ext-code` is evaluated as code, so
`--ext-code stage=prod` fails with an unknown variable where `--ext-str` would
have given you the string.

Plugins extend the CLI, so `--help` differs between projects. `spellcraft doc`
reads the doc comments in a plugin's `module.libsonnet` and the commands it
registers, then replaces the content between marker comments in `README.md`:

```html
<!-- SPELLCRAFT_DOCS_API_START -->
<!-- SPELLCRAFT_DOCS_CLI_START -->
```

## Programmatic API

The CLI is a thin wrapper over `SpellFrame`.

```javascript
const { SpellFrame } = require('@c6fc/spellcraft');

const frame = new SpellFrame({ renderPath: './out' });

(async () => {
    await frame.init();
    const rendered = await frame.render('manifest.jsonnet');

    console.log(Object.keys(rendered));

    frame.write();
})();
```

The **constructor** does the discovery: it loads plugins from your dependency
tree, validates that each plugin's declared `requires` are present, and builds
the `spellcraft_modules/` bridge. It can throw, and it is not free.

`init()` then runs each plugin's init hook once — credentials, network calls,
subprocess launches. `render()` calls it for you if you haven't.

Two renders in the same process — two `SpellFrame`s, or the same one called
twice without awaiting the first — never evaluate at the same time, and
neither do their `init()` calls. Both are serialized process-wide, on
purpose: some plugins keep state in a module-level object rather than
per-instance (`plugins.aws.terraform`'s `projectName`, set by `bootstrap()`
and read by every later `getArtifact()`/`putArtifact()` call, is one case;
`plugins.gcp.auth` handing its resolved credentials to the `googleapis`
library's own global config during `init()` is a sharper one), and that state
is shared by every `SpellFrame` that loads the plugin in the same process.
Without serializing, two concurrent renders' — or two concurrent `init()`
calls' — native calls could interleave their writes to it. The cost is real:
a slow render (or init) blocks every other one queued behind it, even one
sharing no plugins with it at all. For the CLI (one process, one manifest,
one render) this costs nothing; an embedder doing genuinely concurrent
rendering will feel the ceiling.

This closes literal concurrent execution — two native calls never run at the
same instant — but on its own that isn't quite enough: another frame's
`init()` can still be queued *between* a given frame's own `init()` and its
own evaluation (they're separate turns), so a plugin whose state is a bare
module-level singleton could still end up evaluating one frame's manifest
against a *different* frame's resolved identity, just without ever
overlapping in time.

SpellCraft doesn't try to make that safe by making credential state per-frame.
Instead, `plugins.gcp.auth` takes the position that **a process has exactly
one authentication context, ever** — the first successful `init()` locks it
in, and any later `init()` (from any frame) that would resolve to a
*different* identity throws, before touching any credential or making any
call, rather than silently replacing what's active. The same identity twice
is a no-op. A spell needing a different GCP *project* under one identity uses
`providerAliases()`; a genuinely different identity needs a separate process.
`plugins.aws.terraform`/`plugins.gcp.terraform`'s `bootstrap()` applies
the same rule to a spell's own project name — a second `bootstrap()` call
with a different name in the same process throws rather than silently moving
`getArtifact()`/`putArtifact()` to a new namespace mid-manifest.

| Option | Default | Effect |
|---|---|---|
| `renderPath` | `./render` | where `write()` puts files |
| `cleanBeforeRender` | `true` | delete matching files before writing |
| `useDefaultFileHandlers` | `true` | register the built-in serialisers |

Useful methods beyond the three above: `renderString(snippet)`,
`addNativeFunction(name, fn, ...parameterNames)`,
`addFileTypeHandler(pattern, handler)`, and `loadPlugin(packageName, jsMainPath)`
— which is how a plugin's own test harness loads the package it lives in, since
discovery only finds *dependencies*, never the current package.

`addExternalCode(name, value)` backs `std.extVar`, and its name is exact: a
string value is evaluated as **Jsonnet source**, not wrapped as a literal.
Anything else is passed through `JSON.stringify` first, so objects behave the
way you would expect and bare strings do not.

```javascript
frame.addExternalCode('settings', { region: 'us-east-1' });  // std.extVar('settings').region
frame.addExternalCode('name', JSON.stringify('prod'));       // std.extVar('name') === 'prod'
frame.addExternalCode('name', 'prod');                       // STATIC ERROR -- read as Jsonnet code
```

Native function results are memoised per `(name, arguments)` for the life of a
render, so calling `getCallerIdentity()` in forty places costs one API call.
Side effects therefore fire once.

## Events

`SpellFrame` extends Node's `EventEmitter`.

| Event | When | Argument |
|---|---|---|
| `render` | after a manifest evaluates | the rendered object |
| `write` | after files are written | the object written |
| `<package>:<export>` | when a native function actually runs | its arguments |

```javascript
frame.on('render', (output) => console.log('rendered', Object.keys(output)));
```

Because results are memoised, a native function's event fires on the first call
for a given argument list and not on the identical calls that follow. It marks
work actually happening, not the number of call sites.

`emitAsync(event, ...args)` awaits each listener in turn, which is how plugins
order work across packages that know nothing about one another —
`plugins.terraform` emits `@c6fc/spellcraft-plugins:terraform.pre-apply` before
`terraform apply`, and `plugins.gcp.terraform` listens on it to enable
the GCP services the rendered configuration needs first.

## Writing a plugin

A plugin is an npm package with `"spellcraft": true` in its `package.json`,
exporting native functions and an optional `_spellcraft_metadata` block.

```bash
npm init spellcraft-module my-plugin
```

That scaffolds a working plugin whose tests pass on the first run. The contract
is documented at
[spellcraft.io/docs/plugin-contract.html](https://spellcraft.io/docs/plugin-contract.html)
and in [create-spellcraft-module](https://www.npmjs.com/package/create-spellcraft-module).

## Plugins

[**@c6fc/spellcraft-plugins**](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
is one package whose Jsonnet surface is a tree, reached through a single import:

```jsonnet
local plugins = import "@c6fc/spellcraft-plugins/module.libsonnet";

{
	"backend.tf.json": plugins.aws.terraform.bootstrap("my-project"),
	"buckets.tf.json": plugins.aws.terraform.s3.bucket("artifacts", "us-west-2"),
}
```

| Node | Description |
|---|---|
| `plugins.aws.auth` | AWS credentials, role chaining, and the AWS SDK reachable from Jsonnet. |
| `plugins.gcp.auth` | GCP credentials and the googleapis client reachable from Jsonnet. |
| `plugins.terraform` | Provider-neutral Terraform lifecycle: owns `terraform-apply` and its events. |
| `plugins.aws.terraform` | S3 state backend, remote state, and artifact storage for Terraform. |
| `plugins.gcp.terraform` | GCS state backend, remote state, artifacts, and org/project bootstrapping. |
| `plugins.aws.terraform.s3` | Secure-by-default S3 bucket factory, pure Jsonnet. |
| `plugins.aws.terraform.lambda` | Lambda function factory, pure Jsonnet. |
| `plugins.utils.tree` | Nested structure to flat configuration in one pass, pure Jsonnet. |
| `plugins.utils.merge` | Deep merge without `std.mergePatch`'s cost, pure Jsonnet. |

These were seven separately versioned packages until they were collapsed into
one — they depended on each other's internals and always shipped together, so
the independence was nominal. The old packages are deprecated on npm.

## License

MIT © [Brad Woodward](https://github.com/c6fc)
