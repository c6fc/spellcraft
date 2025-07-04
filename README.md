# ✨ SpellCraft ✨

**The Sorcerer's Toolkit for Unified Configuration Management.**

SpellCraft is a powerful framework for generating and managing configurations across a diverse toolchain. It was born from the challenge of orchestrating tools like Terraform, Packer, Kubernetes, and Ansible, each with its own fragmented and isolated configuration format (YAML, JSON, HCL, etc.).

SpellCraft provides a single, unified source of truth, allowing you to generate tightly-integrated, context-aware configurations for any tool, all from one place.

[![NPM Version](https://img.shields.io/npm/v/@c6fc/spellcraft.svg)](https://www.npmjs.com/package/@c6fc/spellcraft)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft.svg)](https://github.com/your-repo/spellcraft/blob/main/LICENSE)

---

## The SpellCraft Philosophy

SpellCraft is built on three core principles to provide a superior Infrastructure-as-Code experience:

1.  **Declarative Power (Jsonnet):** Configurations are written in [Jsonnet](https://jsonnet.org/), a superset of JSON. This gives you the power of variables, functions, conditionals, loops, and inheritance, eliminating the endless copy-pasting and structural limitations of plain YAML or JSON. Define a component once, and reuse it everywhere.

2.  **Seamless Extensibility (Node.js):** Sometimes, declarative logic isn't enough. SpellCraft allows you to "escape" the confines of Jsonnet by writing custom logic in Node.js. Need to fetch a secret from a vault, call a third-party API, or perform complex data manipulation? Simply write a JavaScript function and expose it directly to your Jsonnet code as a `std.native()` function.

3.  **Robust Modularity (NPM):** SpellCraft's module system is built on the battle-tested foundation of NPM. This means you can version, share, and manage your infrastructure modules just like any other software dependency. Leverage public or private NPM registries to build a reusable, maintainable, and collaborative infrastructure codebase.

## Quick Start

Get up and running with SpellCraft in minutes.

### 1. Installation

Install the SpellCraft CLI and core library into your project.

```sh
npm install --save @c6fc/spellcraft
```

### 2. Import a Module

Modules are the building blocks of SpellCraft. Let's import a module for interacting with AWS. The `importModule` command will install the package from NPM and link it into your project.

```sh
npx spellcraft importModule @c6fc/spellcraft-aws-auth

# Expected Output:
# [*] Attempting to install @c6fc/spellcraft-aws-auth...
# [+] Successfully installed @c6fc/spellcraft-aws-auth.
# [+] Linked @c6fc/spellcraft-aws-auth as SpellCraft module 'awsauth'
```
This makes the `@c6fc/spellcraft-aws-auth` package available in your Jsonnet files under the name `awsauth`.

### 3. Create Your First Spell

A "Spell" is a `.jsonnet` file that defines the files you want to create. The top-level keys of the output object become filenames.

Create a file named `manifest.jsonnet`:
```jsonnet
// manifest.jsonnet
local modules = import 'modules';

{
  // The 'awsauth' module provides a native function `getCallerIdentity()`.
  // We call it here and direct its output to a file named 'aws-identity.json'.
  'aws-identity.json': modules.awsauth.getCallerIdentity(),

  // We can also create YAML files. SpellCraft has built-in handlers for common types.
  'config.yaml': {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'my-app-config',
    },
    data: {
      region: std.native('envvar')('AWS_REGION') || 'us-east-1',
      // The result of the native function is just data. We can reuse it!
      callerArn: modules.awsauth.getCallerIdentity().Arn,
    },
  },
}
```

### 4. Generate the Artifacts

Use the `generate` command to render your `.jsonnet` file into the `render/` directory.

```sh
npx spellcraft generate manifest.jsonnet

# Expected Output:
# [+] Linked @c6fc/spellcraft-aws-auth as awsauth.libsonnet
# ...
# [+] Registered native functions [getCallerIdentity, ...] to modules.awsauth
# [+] Evaluating Jsonnet file manifest.jsonnet
# [+] Writing files to: render
#   -> aws-identity.json
#   -> config.yaml
# [+] Generation complete.
```

Check your `render/` directory. You will find two files created from your single source of truth!

```
.
├── manifest.jsonnet
├── node_modules/
├── package.json
└── render/
    ├── aws-identity.json
    └── config.yaml
```

## The SpellCraft CLI

The `spellcraft` CLI is your primary interface for managing modules and generating files.

### Core Commands

-   `generate <filename>`: Renders a `.jsonnet` file and writes the output to the `render/` directory.
-   `importModule <npmPackage> [name]`: Installs an NPM package and links it as a SpellCraft module. If `[name]` is omitted, it uses the default name defined by the module.

### Extensible CLI

Modules can extend the SpellCraft CLI with their own custom commands. For example, after importing `@c6fc/spellcraft-aws-auth`, you gain new AWS-related commands.

Run `npx spellcraft --help` to see all available commands, including those added by modules.

```sh
$ npx spellcraft --help

# ... output showing core commands and module-added commands ...
Commands:
  spellcraft generate <filename>                Generates files from a configuration
  spellcraft importModule <npmPackage> [name]   Configures the current project to use a SpellCraft module
  spellcraft aws-identity                       Display the AWS IAM identity of the SpellCraft context
  spellcraft aws-exportcredentials              Export the current credentials as environment variables
```

## Programmatic Usage (API)

For more advanced workflows, such as integration into larger automation scripts, you can use the `SpellFrame` class directly in your Node.js code.

The typical flow is:
1.  Instantiate `SpellFrame`.
2.  Load necessary modules.
3.  (Optional) Run module initializers with `init()`.
4.  Render the Jsonnet file with `render()`.
5.  Write the resulting object to disk with `write()`.

```javascript
// my-automation-script.js
const { SpellFrame } = require('@c6fc/spellcraft');
const path = require('path');

// 1. Instantiate the SpellFrame
// Options allow you to customize output paths, cleaning behavior, etc.
const frame = new SpellFrame({
  renderPath: "dist", // Output to 'dist/' instead of 'render/'
  cleanBeforeRender: true,
});

(async () => {
  try {
    // 2. Load modules programmatically (this assumes they are in package.json)
    // This loads modules listed in 'spellcraft_modules/packages.json'
    // and from the local 'spellcraft_modules/' directory.
    // frame.loadModuleByName('my-module-key', 'my-npm-package');

    // 3. Initialize modules (if any modules registered an init function)
    await frame.init();

    // 4. Render the master Jsonnet file
    const manifest = await frame.render(path.resolve('./manifest.jsonnet'));

    // The result is available in memory
    console.log('Rendered Manifest:', JSON.stringify(manifest, null, 2));

    // 5. Write the manifest object to the filesystem
    frame.write(manifest);

    console.log('Successfully wrote files to the dist/ directory!');

  } catch (error) {
    console.error('An error occurred during the SpellCraft process:', error);
    process.exit(1);
  }
})();
```

## Creating Your Own Spells (Modules)

When you're ready to start writing your own modules and unleashing the true power of SpellCraft, check out **[create-spellcraft-module](https://www.npmjs.com/package/@c6fc/spellcraft)**