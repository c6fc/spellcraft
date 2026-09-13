#! /usr/bin/env node

'use strict';

const yargs = require('yargs');
const colors = require('@colors/colors');
const { hideBin } = require('yargs/helpers');
const { SpellFrame } = require('../src/index.js');
const DocGenerator = require('../src/doc-generator');


// --ext-str / --ext-code take `name=value`, the same spelling jsonnet(1) uses.
// Only the first '=' separates: a value may contain as many as it likes.
function parseExternalAssignments(values, flag) {
    return (Array.isArray(values) ? values : []).map((entry) => {
        const text = String(entry);
        const split = text.indexOf('=');

        if (split < 1) {
            throw new Error(`--${flag} takes name=value; '${text}' has no name.`);
        }

        return [text.slice(0, split), text.slice(split + 1)];
    });
}

(async () => {
    function setupCli(sfInstance) {
        let cli = yargs(hideBin(process.argv))
            .usage("Syntax: $0 <command> [options]")
            .scriptName("spellcraft")

            // No "*" catch-all command. One used to sit here, and it made both
            // .recommendCommands() below and its own "[~] That's too arcane."
            // message unreachable: with a catch-all registered, no command is
            // ever *unknown*, so a typo was caught by .strict() as
            // `Unknown arguments: genrate, x.jsonnet` and the suggestion never
            // fired. Without it, `spellcraft genrate x.jsonnet` gets "Did you
            // mean generate?", and a bare `spellcraft` gets .demandCommand()'s
            // message instead of a handler pretending it understood.

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
                }).option('ext-str', {
                    type: 'array',
                    description: 'Bind a std.extVar as a string: --ext-str name=value (repeatable)'
                }).option('ext-code', {
                    type: 'array',
                    description: 'Bind a std.extVar as Jsonnet code: --ext-code name=<expression> (repeatable)'
                });
            },
            async (argv) => {
                // Read by its own name rather than the alias, so renaming the
                // alias cannot quietly disable it.
                if (argv['skip-module-cleanup']) {
                    sfInstance.cleanModulesAfterRender = false;
                }

                // addExternalCode() passes a string through as *code*, which is
                // what --ext-code wants verbatim. --ext-str has to say it means a
                // string literal, or a bare `prod` reaches Jsonnet as an
                // identifier and fails; JSON.stringify is how you say that.
                for (const [name, value] of parseExternalAssignments(argv['ext-code'], 'ext-code')) {
                    sfInstance.addExternalCode(name, value);
                }

                for (const [name, value] of parseExternalAssignments(argv['ext-str'], 'ext-str')) {
                    sfInstance.addExternalCode(name, JSON.stringify(value));
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
        // Constructed inside the try, not at module scope. The constructor does
        // real work -- plugin discovery, and reading every spellcraft_modules
        // file -- so it can fail on an ordinary mistake, such as a local module
        // whose parameter is named after a Jsonnet keyword. From module scope
        // that reached the user as a raw stack trace with the actual message
        // buried in it, which is the same failure the .fail() handler below
        // exists to prevent.
        await setupCli(new SpellFrame());
    } catch (error) {
        console.error(`[!] ${error.message}`.red);
        process.exit(1);
    }
})();