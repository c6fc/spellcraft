const fs = require('fs');
const path = require('path');

class DocGenerator {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    generate() {
        const readmePath = path.join(this.baseDir, 'README.md');
        if (!fs.existsSync(readmePath)) {
            console.error("[!] No README.md found.");
            return;
        }

        let readmeContent = fs.readFileSync(readmePath, 'utf-8');
        const apiDocs = this.parseJsonnetDocs();
        const cliDocs = this.parseCliDocs();

        readmeContent = this.replaceSection(readmeContent, 'API', apiDocs);
        readmeContent = this.replaceSection(readmeContent, 'CLI', cliDocs);

        fs.writeFileSync(readmePath, readmeContent);
        console.log("[+] README.md updated with generated documentation.");
    }

    // Helper to replace content between <!-- SPELLCRAFT_DOCS_XYZ_START --> tags
    replaceSection(content, sectionName, newContent) {
        const startTag = `<!-- SPELLCRAFT_DOCS_${sectionName}_START -->`;
        const endTag = `<!-- SPELLCRAFT_DOCS_${sectionName}_END -->`;
        const regex = new RegExp(`${startTag}[\\s\\S]*?${endTag}`, 'g');
        
        if (!regex.test(content)) {
            console.log(`[-] No tags exist for ${sectionName}. Skipping.`);
            // Do nothing if the tags don't exist.
            return content;
        }

        return content.replace(regex, `${startTag}\n${newContent}\n${endTag}`);
    }

    parseJsonnetDocs() {
        const libPath = path.join(this.baseDir, 'module.libsonnet');
        if (!fs.existsSync(libPath)) return '';

        const content = fs.readFileSync(libPath, 'utf-8');
        // Finds a /** comment */ followed by a member definition.
        // Captures: 1=Comment content, 2=FunctionName, 3=Args
        //
        // The argument list runs to the ')' that precedes the member's ':' or
        // '::', rather than to the first ')' encountered — a default value may
        // call a function, as in `api(path, params={ project: getProjectId() })`,
        // and stopping at the first ')' truncated the signature mid-way.
        //
        // The comment capture is bounded so it cannot cross a '*/'. It used to be
        // a plain lazy `([\s\S]*?)`, which is lazy but unbounded: when the member
        // following a doc comment has no parentheses -- a documented constant,
        // `version:: "1.0.0"` -- the match could not complete there, so the engine
        // extended the *comment* past its own terminator until it found a member
        // that did have them. Two members then collapsed into one entry, with the
        // raw Jsonnet source between them printed as documentation prose, in a
        // README that then gets published. Bounded, a doc comment with no
        // function after it simply does not match, and is reported below.
        const regex = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*\n\s*([\w]+)\(([\s\S]*?)\)\s*::?(?!:)/g;

        let match;
        let markdown = "## API Reference\n\n";

        // Where each documented member's comment began, so the ones that matched
        // nothing can be named afterwards.
        const documented = new Set();

        while ((match = regex.exec(content)) !== null) {
            documented.add(match.index);
            const rawCommentLines = match[1].split('\n').map(line => 
                // Remove the "   * " from the start of lines
                line.replace(/^\s*\*\s?/, '')
            );

            const funcName = match[2];
            const args = match[3];

            let description = [];
            let params = [];
            let examples = []; // Array of arrays (one per example block)
            let currentExampleBlock = null;
            let mode = 'description'; 

            rawCommentLines.forEach(line => {
                const trimmed = line.trim();

                // 1. Detect new @example block
                if (trimmed.startsWith('@example')) {
                    mode = 'example';
                    currentExampleBlock = []; // Start a new container
                    examples.push(currentExampleBlock);
                    return; // Skip the tag line itself
                }

                // 2. Detect Metadata tags (@param, @return)
                // We handle these regardless of mode, assuming they aren't part of the code example
                if (trimmed.startsWith('@param') || trimmed.startsWith('@return')) {
                    // Strip the @ and format as a list item
                    params.push(`- ${trimmed.substring(1)}`);
                    return; 
                }

                // 3. Capture Content
                if (mode === 'example') {
                    // Add line to the currently active example block
                    if (currentExampleBlock) {
                        currentExampleBlock.push(line);
                    }
                } else {
                    // Add line to general description
                    description.push(line);
                }
            });

            // --- Build Markdown Output ---

            markdown += `### \`${funcName}(${args})\`\n\n`;

            // 1. Description
            if (description.length > 0) {
                markdown += description.join('\n').trim() + "\n\n";
            }

            // 2. Parameters / Returns
            if (params.length > 0) {
                markdown += params.join('\n') + "\n\n";
            }

            // 3. Examples (Loop through the array)
            if (examples.length > 0) {
                markdown += "**Examples:**\n\n";
                examples.forEach(exBlock => {
                    // Polish: Join lines and trim empty leading/trailing newlines
                    const code = exBlock.join('\n').trim();
                    if (code.length > 0) {
                        markdown += "```jsonnet\n";
                        markdown += code + "\n";
                        markdown += "```\n\n";
                    }
                });
            }

            markdown += "---\n";
        }

        // A doc comment that documented nothing. Before the capture was bounded
        // this was silent *and* corrupting; now it is merely silent, which is
        // still how a convention ends up as folklore -- the plugin tree works
        // around it by writing line comments on parenless members, and nothing
        // tells the next author that rule exists.
        const anyDocComment = /\/\*\*(?:(?!\*\/)[\s\S])*?\*\//g;
        let stray;

        while ((stray = anyDocComment.exec(content)) !== null) {
            if (documented.has(stray.index)) continue;

            const before = content.slice(0, stray.index);

            // A '/**' written inside a line comment is prose about doc comments,
            // not one. This scan is a plain regex with no idea what it is reading
            // -- the same limitation the native-reference scanner has -- and the
            // text most likely to mention '/** */' is a comment explaining when
            // not to use one.
            if (/\/\/[^\n]*$/.test(before)) continue;

            const line = before.split('\n').length;
            console.warn(
                `[-] Skipped the doc comment at ${path.basename(libPath)}:${line} -- ` +
                `no function follows it. Only members with parentheses are documented; ` +
                `use a // line comment for anything else.`
            );
        }

        return markdown;
    }

    parseCliDocs() {
        // A plugin's entry point is conventionally module.js, but it is whatever
        // its package.json calls `main` -- and a package built as a tree of nodes
        // (see @c6fc/spellcraft-plugins) gives each node its own index.js, with
        // module.js nowhere in sight. Looking only for module.js silently emptied
        // the CLI section of every such node's README instead of documenting it.
        const jsPath = ['module.js', 'index.js']
            .map((name) => path.join(this.baseDir, name))
            .find((candidate) => fs.existsSync(candidate));

        if (!jsPath) return '';

        try {
            // Load the module (Bypass cache to ensure fresh read)
            delete require.cache[require.resolve(jsPath)];
            const moduleExports = require(jsPath);
            const meta = moduleExports._spellcraft_metadata;

            // Guard clauses
            if (!meta || !meta.cliExtensions || typeof meta.cliExtensions !== 'function') {
                return '';
            }

            const capturedCommands = [];

            // Create a Proxy/Mock object to intercept yargs calls
            const mockYargs = {
                command: (command, description, ...args) => {
                    // Capture the essential info
                    capturedCommands.push({ command, description });
                    return mockYargs; // Return self to allow chaining .command().command()
                },
                
                // Stub out other common yargs methods so the script doesn't crash
                // if the module uses .usage(), .option(), etc.
                usage: () => mockYargs,
                scriptName: () => mockYargs,
                demandCommand: () => mockYargs,
                recommendCommands: () => mockYargs,
                strict: () => mockYargs,
                showHelpOnFail: () => mockYargs,
                help: () => mockYargs,
                alias: () => mockYargs,
                version: () => mockYargs,
                epilogue: () => mockYargs,
                option: () => mockYargs,
                positional: () => mockYargs,
                group: () => mockYargs,
            };

            // Mock SpellFrame (The second argument passed to cliExtensions)
            // We mock this just in case the extension tries to read properties from it immediately
            const mockSpellFrame = {
                init: async () => {},
                render: async () => {},
                write: () => {},
            };

            // Execute the function!
            meta.cliExtensions(mockYargs, mockSpellFrame);

            // Generate Markdown
            if (capturedCommands.length === 0) return '';

            let markdown = "## CLI Commands\n\n";
            
            capturedCommands.forEach(c => {
                // If description is explicitly false (hidden command), skip it
                if (c.description === false) return;

                markdown += `- **\`spellcraft ${c.command}\`**\n`;
                markdown += `  ${c.description}\n`;
            });

            return markdown;

        } catch (e) {
            console.warn(`[!] Failed to parse CLI docs from ${path.basename(jsPath)}: ${e.message}`);
            return '';
        }
    }
}

module.exports = DocGenerator;