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
        // Regex to find /** comments */ followed by a function definition
        // Captures: 1=Comment content, 2=FunctionName, 3=Args
        const regex = /\/\*\*([\s\S]*?)\*\/\s*\n\s*([\w]+)\(([^)]*)\)/g;
        
        let match;
        let markdown = "## API Reference\n\n";

        while ((match = regex.exec(content)) !== null) {
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
        return markdown;
    }

    parseCliDocs() {
        const jsPath = path.join(this.baseDir, 'module.js');
        if (!fs.existsSync(jsPath)) return '';

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
            console.warn(`[!] Failed to parse CLI docs from module.js: ${e.message}`);
            return '';
        }
    }
}

module.exports = DocGenerator;