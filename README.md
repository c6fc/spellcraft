# ✨ SpellCraft ✨

**The Sorcerer's Toolkit for Unified Configuration Management.**

SpellCraft is a plugin framework for [Jsonnet](https://jsonnet.org/) that bridges the gap between declarative configuration and the Node.js ecosystem. It allows you to import NPM packages directly into your Jsonnet logic, execute native JavaScript functions during configuration generation, and manage complex infrastructure-as-code requirements from a single, gnostic workflow.

SpellCraft provides a single, unified source of truth, letting you orchestrate any tool that needs machine-readable configurations (like Terraform, Packer, Kubernetes, or Ansible) from one place.

[![NPM Version](https://img.shields.io/npm/v/@c6fc/spellcraft.svg)](https://www.npmjs.com/package/@c6fc/spellcraft)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft.svg)](https://github.com/c6fc/spellcraft/blob/main/LICENSE)

---

## The SpellCraft Philosophy

1.  **Declarative Power (Jsonnet):** Configurations are written in Jsonnet. Variables, functions, and inheritance allow you to define components once and reuse them everywhere.
2.  **Native Node.js Resolution:** No custom registries. No hidden magic. SpellCraft modules are just NPM packages. If you can `npm install` it, SpellCraft can load it.
3.  **Scoped Extensibility:** Native JavaScript functions are automatically namespaced based on their package name, ensuring that dependencies never clash, even if multiple modules use different versions of the same library.

## Quick Start

### 1. Installation

Install the CLI and core library.

```sh
npm install --save @c6fc/spellcraft
```

### 2. Install a Plugin

Install a SpellCraft-compatible plugin using standard NPM.

```sh
npm install --save @c6fc/spellcraft-aws-auth
```

### 3. Write Your Spell

Create a `manifest.jsonnet` file. Unlike previous versions of SpellCraft, you import modules explicitly using standard Node resolution.

```jsonnet
// Import the library directly from node_modules
local aws = import '@c6fc/spellcraft-aws-auth/module.libsonnet';

{
  // Use functions provided by the module
  'aws-identity.json': aws.getCallerIdentity(),

  'config.yaml': {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'my-app-config' },
    data: {
      // Use built-in native functions
      region: std.native('envvar')('AWS_REGION') || 'us-east-1',
      callerArn: aws.getCallerIdentity().Arn,
    },
  },
}
```

### 4. Generate Artifacts

Run the generator. SpellCraft automatically detects installed plugins in your `package.json`, registers their native functions, and renders your configuration.

```sh
npx spellcraft generate manifest.jsonnet

# Expected Output:
# [+] Evaluating Jsonnet file: .../manifest.jsonnet
# [+] Writing files to: render
#   -> aws-identity.json
#   -> config.yaml
# [+] Generation complete.
```

---

## Rapid Prototyping (Local Modules)

Sometimes you need a custom function just for your current project, and you don't want to publish a full NPM package. SpellCraft provides a **Local Magic** folder for this.

1.  Create a folder named `spellcraft_modules` in your project root.
2.  Create a JavaScript file, e.g., `spellcraft_modules/utils.js`:

```javascript
// spellcraft_modules/utils.js
exports.shout = (text) => text.toUpperCase() + "!!!";
exports.add = (a, b) => a + b;

// Use standard functions to access 'this', which is extended by plugins:
exports.know_thyself = function() {
  this.aws.getCallerIdentity()
}
```

3.  In your Jsonnet file, import `modules` to access your exported functions:

```jsonnet
// Import the automatically generated local module aggregator
local modules = import 'modules';

{
  'test.json': {
    // Access your local JS functions here
    // Our file was named 'utils.js', so the exported
    // functions are accessed via 'modules.utils'.
    message: modules.utils.shout("hello world"),
    sum: modules.utils.add(10, 5)
  }
}
```

---

## The SpellCraft CLI

The CLI is automatically extended by installed modules.

*   `spellcraft generate <filename>`: Renders a Jsonnet file to the `render/` directory.
*   `spellcraft --help`: Lists all available commands, including those added by plugins (e.g., `spellcraft aws-identity`).

---

## Programmatic API

You can embed SpellCraft into your own Node.js scripts for advanced automation.

```javascript
const { SpellFrame } = require('@c6fc/spellcraft');
const path = require('path');

const frame = new SpellFrame();

(async () => {
    // 1. Initialize: Scans package.json for plugins and loads them
    await frame.init();

    // 2. Render: Evaluates the Jsonnet
    // Note: The result is a pure JS object
    const result = await frame.render(path.resolve('./manifest.jsonnet'));
    console.log(result);

    // 3. Write: Outputs files to disk (applying JSON/YAML transformations)
    frame.write();
})();
```

## Creating Modules

A SpellCraft module is simply an NPM package with specific metadata. You can get a head-start with:
```bash
npm init spellcraft-module @your_org/your_module
```

Learn more at [**create-spellcraft-module**](https://www.npmjs.com/package/create-spellcraft-module)

## Community Modules

| Package | Description |
|---|---|
| [**@c6fc/spellcraft-aws-auth**](https://www.npmjs.com/package/@c6fc/spellcraft-aws-auth) | AWS SDK authentication and API calls directly from Jsonnet. |
| [**@c6fc/spellcraft-terraform**](https://www.npmjs.com/package/@c6fc/spellcraft-terraform) | Terraform integration and state management. |

---

## License

MIT © [Brad Woodward](https://github.com/c6fc)