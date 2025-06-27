#! /usr/bin/env node

/**
 * @fileOverview SpellCraft CLI tool.
 * This script provides a command-line interface for interacting with the SpellFrame
 * rendering engine. It allows users to generate configurations from Jsonnet files
 * and manage SpellCraft modules.
 * @module spellcraft-cli
 */

'use strict';

const yargs = require('yargs');
const colors = require('@colors/colors');
const { hideBin } = require('yargs/helpers');
const { SpellFrame } = require('../src/index.js');

const spellframe = new SpellFrame();

// --- JSDoc Blocks for CLI Commands ---
// These blocks define the commands for JSDoc.
// They are not directly attached to yargs code but describe the CLI's public interface.

/**
 * Generates files from a Jsonnet configuration.
 * This command processes a specified Jsonnet configuration file using the SpellFrame engine,
 * renders the output, and writes the resulting files to the configured directory.
 *
 * **Usage:** `spellcraft generate <filename>`
 *
 * @function generate
 * @name module:spellcraft-cli.generate
 * @param {object} argv - The arguments object provided by yargs.
 * @param {string} argv.filename The path to the Jsonnet configuration file to consume. (Required)
 *
 * @example
 * spellcraft generate ./myconfig.jsonnet
 */

/**
 * Links an npm package as a SpellCraft module for the current project.
 * This command installs the specified npm package (if not already present) and
 * registers it within the project's SpellCraft module configuration, making its
 * functionalities available during the rendering process.
 *
 * **Usage:** `spellcraft importModule <npmPackage> [name]`
 *
 * @function importModule
 * @name module:spellcraft-cli.importModule
 * @param {object} argv - The arguments object provided by yargs.
 * @param {string} argv.npmPackage The NPM package name of the SpellCraft Plugin to import. (Required)
 * @param {string} [argv.name] An optional alias name to use for this module within SpellCraft.
 *                             If not provided, a default name from the package may be used.
 *
 * @example
 * spellcraft importModule my-spellcraft-enhancer
 * @example
 * spellcraft importModule @my-scope/spellcraft-utils customUtils
 */

// --- End of JSDoc Blocks for CLI Commands ---

(async () => {
    // No JSDoc for setupCli as it's an internal helper
    function setupCli(sfInstance) {
        let cli = yargs(hideBin(process.argv))
            .usage("Syntax: $0 <command> [options]")
            .scriptName("spellcraft")

            .command("*", false, (yargsInstance) => { // 'false' for no yargs description
                return yargsInstance;
            }, (argv) => {
                console.log("[~] That's too arcane. (Unrecognized command)");
            })

            .command("generate <filename>", "Generates files from a configuration", (yargsInstance) => {
                return yargsInstance.positional('filename', {
                    describe: 'Jsonnet configuration file to consume',
                    type: 'string',
                    demandOption: true,
                });
            },
            async (argv) => { // No JSDoc for internal handler
                try {
                    await sfInstance.init();
                    await sfInstance.render(argv.filename);
                    await sfInstance.write();
                    console.log("[+] Generation complete.");
                } catch (error) {
                    console.error(`[!] Error during generation: ${error.message.red}`);
                    process.exit(1);
                }
            })

            .command("importModule <npmPackage> [name]", "Configures the current project to use a SpellCraft plugin as an import", (yargsInstance) => {
                return yargsInstance
                    .positional('npmPackage', {
                        describe: 'The NPM package name of a SpellCraft Plugin to import',
                        type: 'string',
                        demandOption: true,
                    })
                    .positional('name', {
                        describe: 'Optional alias name for the module in SpellCraft',
                        type: 'string',
                        default: undefined,
                    });
            },
            async (argv) => {
                await sfInstance.importSpellCraftModuleFromNpm(argv.npmPackage, argv.name);
                console.log(`[+] Module '${argv.npmPackage.green}' ${argv.name ? `(aliased as ${argv.name.green})` : ''} linked successfully.`);
            });

        // No JSDoc for CLI extensions loop if considered internal detail
        if (sfInstance.cliExtensions && sfInstance.cliExtensions.length > 0) {
            sfInstance.cliExtensions.forEach((extensionFn) => {
                if (typeof extensionFn === 'function') {
                    extensionFn(cli, sfInstance);
                }
            });
        }

        cli
            .demandCommand(1, 'You need to specify a command.')
            .recommendCommands()
            .strict()
            .showHelpOnFail(true)
            .help("help")
            .alias('h', 'help')
            .version()
            .alias('v', 'version')
            .epilogue('For more information, consult the SpellCraft documentation.')
            .argv;
    }

    try {
        setupCli(spellframe);
    } catch (error) {
        console.error(`[!] A critical error occurred: ${error.message}`);
        process.exit(1);
    }
})();