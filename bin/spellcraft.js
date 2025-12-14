#! /usr/bin/env node

'use strict';

const yargs = require('yargs');
const colors = require('@colors/colors');
const { hideBin } = require('yargs/helpers');
const { SpellFrame } = require('../src/index.js');
const DocGenerator = require('../src/doc-generator');

const spellframe = new SpellFrame();

(async () => {
    function setupCli(sfInstance) {
        let cli = yargs(hideBin(process.argv))
            .usage("Syntax: $0 <command> [options]")
            .scriptName("spellcraft")

            .command("*", false, (yargsInstance) => { // 'false' for no yargs description
                return yargsInstance;
            }, (argv) => {
                console.log("[~] That's too arcane. (Unrecognized command)");
            })

            .command("doc", "Generates Markdown documentation for the current module and updates README.md", () => {}, 
            (argv) => {
                const generator = new DocGenerator(process.cwd());
                generator.generate();
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
            async (argv) => {
                if (argv['s']) {
                    sfInstance.cleanModulesAfterRender = false;
                }

                await sfInstance.init();
                await sfInstance.render(argv.filename);
                await sfInstance.write();
                console.log("[+] Generation complete.");
            })

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