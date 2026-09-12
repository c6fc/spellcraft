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
                    description: 'Keep the generated spellcraft_modules aggregate (.spellcraft/modules) for inspection'
                });
            },
            async (argv) => {
                // Read by its own name rather than the alias, so renaming the
                // alias cannot quietly disable it.
                if (argv['skip-module-cleanup']) {
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

        return cli
            .demandCommand(1, 'You need to specify a command.')
            .recommendCommands()
            .strict()
            .showHelpOnFail(true)
            .help("help")
            .alias('h', 'help')
            // Pinned, not guessed. yargs' bare .version() walks up from wherever
            // *yargs itself* resolved to and takes the first package.json outside
            // node_modules -- which in any consumer project is the consumer's own
            // package.json, so `spellcraft --version` reported the user's project
            // version rather than SpellCraft's. (Under the dev workspace it
            // reported the overlay's 0.0.0, which is how it was spotted.)
            .version(require('../package.json').version)
            .alias('v', 'version')
            .epilogue('For more information, consult the SpellCraft documentation.')

            // yargs routes two unrelated things through .fail(): a usage error it
            // detected itself (`msg`), and an error thrown by a command handler
            // (`err`). They want opposite treatment.
            //
            // The exit code was never the problem -- Node makes an unhandled
            // rejection fatal, so a failing command already exited 1. What a user
            // saw was the wrong thing entirely: the command's own help text, then
            // a raw stack trace, and no clear statement of what went wrong. A
            // .fail() that prints and returns instead of rethrowing swaps that for
            // the message printed twice, which is not much better.
            .fail((msg, err, yargsInstance) => {

                // A handler threw. Rethrow so parseAsync()'s rejection carries it
                // to the catch below, which reports it and sets the exit code.
                if (err) throw err;

                // A usage error. A custom .fail() replaces showHelpOnFail, so
                // print the help it would have printed -- .recommendCommands()
                // puts its "did you mean" suggestion in `msg`.
                yargsInstance.showHelp();
                console.error(`\n[!] ${msg}`.red);
                process.exit(1);
            })

            // parseAsync, not .argv: command handlers are async, and .argv gives
            // no promise to await, so a handler's rejection escaped this function
            // entirely. The try/catch below could only ever catch synchronous
            // setup errors, which is why a failing command used to print yargs'
            // raw stack trace under the command's own help text.
            .parseAsync();
    }

    try {
        await setupCli(spellframe);
    } catch (error) {
        console.error(`[!] ${error.message}`.red);
        process.exit(1);
    }
})();