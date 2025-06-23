# SpellCraft for JSonnet workflows

Spellcraft is an opinionated approach to manifesting and applying configurations for various tools. SpellCraft is the core engine which can accept plugins like @c6fc/spellcraft-packer for Hashicorp Packer configurations, or @c6fc/spellcraft-aws for interacting with Amazon Web Services

## Installation

Install spellcraft with `npm install` and add plugins with `npx spellcraft importModule`

```sh
$ npm i -p @c6fc/spellcraft
$ npx spellcraft importModule @c6fc/spellcraft-packer packer
```

The importModule command above will expose the methods from `@c6fc/spellcraft-packer` with `local packer = require "packer"`


## More details to be added soon