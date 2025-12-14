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
                }).option('skip-module-cleanup', {
                    alias: 's',
                    type: 'boolean',
                    description: 'Leave temporary modules intact after rendering'
                });
            },
            async (argv) => { // No JSDoc for internal handler
                // try {
                    if (argv['s']) {
                        sfInstance.cleanModulesAfterRender = false;
                    }

                    await sfInstance.init();
                    await sfInstance.render(argv.filename);
                    await sfInstance.write();
                    console.log("[+] Generation complete.");
                /*} catch (error) {
                    console.error(`[!] Error during generation: ${error.message.red}`);
                    process.exit(1);
                }*/
            })

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