'use strict';

const fs = require("fs");
const path = require("path");
const yaml = require('js-yaml');
const crypto = require('crypto');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const baseDir = process.cwd();

const defaultFileTypeHandlers = {
    '.*?\.json$': (content) => JSON.stringify(content, null, 4),
    '.*?\.yaml$': (content) => yaml.dump(content, { indent: 4 }),
    '.*?\.yml$': (content) => yaml.dump(content, { indent: 4 }),
};

const defaultFileHandler = (content) => JSON.stringify(content, null, 4);

function getFunctionParameterList(func) {
    let funcStr = func.toString()
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/(.)*/g, '')
        .replace(/{[\s\S]*}/, '')
        .replace(/=>/g, '')
        .trim();

    const paramStartIndex = funcStr.indexOf("(") + 1;
    const paramEndIndex = funcStr.lastIndexOf(")");

    if (paramStartIndex === 0 || paramEndIndex === -1 || paramStartIndex >= paramEndIndex) {
        const potentialSingleArg = funcStr.split('=>')[0].trim();
        if (potentialSingleArg && !potentialSingleArg.includes('(') && !potentialSingleArg.includes(')')) {
            return [potentialSingleArg].filter(p => p.length > 0);
        }
        return [];
    }

    const paramsString = funcStr.substring(paramStartIndex, paramEndIndex);
    if (!paramsString.trim()) return [];

    return paramsString.split(",")
        .map(param => param.replace(/=[\s\S]*/g, '').trim())
        .filter(param => param.length > 0);
}

exports.SpellFrame = class SpellFrame {
    constructor(options = {}) {
        const defaults = {
            renderPath: "./render",
            cleanBeforeRender: true,
            useDefaultFileHandlers: true
        };

        Object.assign(this, defaults, options);

        this.initFn = [];
        this._cache = {};
        this.cliExtensions = [];
        this.fileTypeHandlers = (this.useDefaultFileHandlers) ? { ...defaultFileTypeHandlers } : {};
        this.functionContext = {};
        this.lastRender = null;
        this.activePath = null;

        this.jsonnet = new Jsonnet()
            .addJpath(path.join(__dirname, '../lib'))
            // REFACTOR: Look in the local project's node_modules for explicit imports
            .addJpath(path.join(baseDir, 'node_modules')); 

        // Built-in native functions
        this.addNativeFunction("envvar", (name) => process.env[name] || false, "name");
        this.addNativeFunction("path", () => this.activePath || process.cwd());

        // REFACTOR: Automatically find and register plugins from package.json
        this.loadPluginsFromDependencies();
    }

    _generateCacheKey(functionName, args) {
        return crypto.createHash('sha256').update(JSON.stringify([functionName, ...args])).digest('hex');
    }

    addFileTypeHandler(pattern, handler) {
        Object.defineProperty(this.fileTypeHandlers, pattern, {
            value: handler,
            writable: false,
            enumerable: true,
            configurable: true
        });
        return this;
    }

    addNativeFunction(name, func, ...parameters) {
        this.jsonnet.nativeCallback(name, (...args) => {
            const key = this._generateCacheKey(name, args);
            if (this._cache[key] !== undefined) {
                return this._cache[key];
            }
            const result = func.apply(this.functionContext, args);
            this._cache[key] = result;
            return result;
        }, ...parameters);
        return this;
    }

    addExternalCode(name, value) {
        const finalValue = (typeof value === "string") ? value : JSON.stringify(value);
        this.jsonnet = this.jsonnet.extCode(name, finalValue);
        return this;
    }

    extendWithModuleMetadata(metadata) {
        if (metadata.fileTypeHandlers) {
            Object.entries(metadata.fileTypeHandlers).forEach(([pattern, handler]) => {
                this.addFileTypeHandler(pattern, handler);
            });
        }
        if (metadata.cliExtensions) {
            this.cliExtensions.push(...(Array.isArray(metadata.cliExtensions) ? metadata.cliExtensions : [metadata.cliExtensions]));
        }
        if (metadata.initFn) {
            this.initFn.push(...(Array.isArray(metadata.initFn) ? metadata.initFn : [metadata.initFn]));
        }
        Object.assign(this.functionContext, metadata.functionContext || {});
        return this;
    }

    async init() {
        for (const step of this.initFn) {
            await step.call();
        }
    }

    /**
     * REFACTOR: Scans the project's package.json for dependencies.
     * If a dependency has a 'spellcraft' key in its package.json, 
     * load its JS entrypoint and register native functions safely.
     */
    loadPluginsFromDependencies() {
        const packageJsonPath = path.join(baseDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (e) { return; }

        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        Object.keys(deps).forEach(depName => {
            try {
                // Resolve the package.json of the dependency
                const depPath = path.dirname(require.resolve(`${depName}/package.json`, { paths: [baseDir] }));
                const depPkg = require(`${depName}/package.json`);

                // Only load if it marks itself as a spellcraft module
                if (depPkg.spellcraft || depPkg.keywords?.includes("spellcraft-module")) {
                    this.loadPlugin(depName, depPkg.main ? path.join(depPath, depPkg.main) : null);
                }
            } catch (e) {
                // Dependency might not be installed or resolvable, skip quietly
            }
        });
    }

    /**
     * REFACTOR: Loads a specific plugin JS file.
     * Namespaces native functions using the package name to prevent collisions.
     * e.g., @c6fc/spellcraft-aws-auth exports 'aws' -> registered as '@c6fc/spellcraft-aws-auth:aws'
     */
    loadPlugin(packageName, jsMainPath) {
        if (!jsMainPath || !fs.existsSync(jsMainPath)) return;

        let moduleExports;
        try {
            moduleExports = require(jsMainPath);
        } catch (e) {
            console.warn(`[!] Failed to load plugin ${packageName}: ${e.message}`);
            return;
        }

        if (moduleExports._spellcraft_metadata) {
            this.extendWithModuleMetadata(moduleExports._spellcraft_metadata);
        }

        Object.keys(moduleExports).forEach(key => {
            if (key === '_spellcraft_metadata') return;

            let func, params;
            if (Array.isArray(moduleExports[key])) {
                [func, ...params] = moduleExports[key];
            } else if (typeof moduleExports[key] === "function") {
                func = moduleExports[key];
                params = getFunctionParameterList(func);
            } else {
                return; 
            }

            // REGISTER WITH NAMESPACE
            // This is the key fix. We prefix the function name with the package name.
            const uniqueId = `${packageName}:${key}`;
            this.addNativeFunction(uniqueId, func, ...params);
            
            // Optional: Log debug info
            // console.log(`[+] Registered native function: ${uniqueId}`);
        });
    }

    async render(file) {
        const absoluteFilePath = path.resolve(file);
        if (!fs.existsSync(absoluteFilePath)) {
            throw new Error(`SpellCraft Render Error: Input file ${absoluteFilePath} does not exist.`);
        }

        this.activePath = path.dirname(absoluteFilePath);

        if (this.renderPath.endsWith(path.sep)) {
            this.renderPath = this.renderPath.slice(0, -1);
        }

        try {
            console.log(`[+] Evaluating Jsonnet file: ${absoluteFilePath}`);
            this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(absoluteFilePath));
        } catch (e) {
            throw new Error(`Jsonnet Evaluation Error: ${e.message || e}`);
        }
        
        return this.lastRender;
    }

    async renderString(snippet) {

        this.activePath = process.cwd();

        try {
            this.lastRender = JSON.parse(await this.jsonnet.evaluateSnippet(snippet));
        } catch (e) {
            throw new Error(`Jsonnet Evaluation Error: ${e.message || e}`);
        }
        
        return this.lastRender;
    }

    // Removed: importSpellCraftModuleFromNpm
    // Removed: loadModulesFromModuleDirectory
    // Removed: loadModulesFromPackageList
    // Removed: loadModuleByName (file copier)

    write(filesToWrite = this.lastRender) {
        if (!filesToWrite || typeof filesToWrite !== 'object') return this;

        if (!fs.existsSync(this.renderPath)) {
            fs.mkdirSync(this.renderPath, { recursive: true });
        }

        if (this.cleanBeforeRender) {
            // ... (Cleaning logic remains the same)
             try {
                Object.keys(this.fileTypeHandlers).forEach(regexPattern => {
                    const regex = new RegExp(regexPattern, "i");
                    if(fs.existsSync(this.renderPath)) {
                        fs.readdirSync(this.renderPath).filter(f => regex.test(f)).forEach(f => fs.unlinkSync(path.join(this.renderPath, f)));
                    }
                });
            } catch (e) {}
        }

        console.log(`[+] Writing files to: ${this.renderPath}`);
        for (const filename in filesToWrite) {
            if (Object.prototype.hasOwnProperty.call(filesToWrite, filename)) {
                const outputFilePath = path.join(this.renderPath, filename);
                const [, handlerFn] = Object.entries(this.fileTypeHandlers)
                    .find(([pattern]) => new RegExp(pattern).test(filename)) || [null, defaultFileHandler];

                try {
                    fs.writeFileSync(outputFilePath, handlerFn(filesToWrite[filename]), 'utf-8');
                    console.log('  -> ' + path.basename(outputFilePath));
                } catch (e) {
                     console.error(`  [!] Error writing ${filename}: ${e.message}`);
                }
            }
        }
        return this;
    }
};