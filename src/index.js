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
        this.visitedPlugins = new Set();
        this.loadedPlugins = new Map();
        this.isInitialized = false;

        this.jsonnet = new Jsonnet()
            .addJpath(path.join(__dirname, '../lib'))
            // REFACTOR: Look in the local project's node_modules for explicit imports
            .addJpath(path.join(baseDir, 'node_modules'))
            .addJpath(path.join(baseDir, '.spellcraft'));

        // Built-in native functions
        this.addNativeFunction("envvar", (name) => process.env[name] || false, "name");
        this.addNativeFunction("path", () => this.activePath || process.cwd());

        // REFACTOR: Automatically find and register plugins from package.json
        this.loadPluginsFromDependencies();
        this.loadPluginsRecursively(baseDir);
        this.validatePluginRequirements();

        // 2. Load Local Magic Modules (Rapid Prototyping Mode)
        this.loadLocalMagicModules();
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

        if (metadata.init) {
            this.initFn.push(...(Array.isArray(metadata.init) ? metadata.init : [metadata.init]));
        }

        Object.assign(this.functionContext, metadata.functionContext || {});
        return this;
    }

    async init() {
        if (this.isInitialized) return;

        for (const step of this.initFn) {
            await step.call();
        }

        this.isInitialized = true;
    }

    loadPluginsFromDependencies() {
        const packageJsonPath = path.join(baseDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (e) { return; }

        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        // Create a require function that operates as if it's inside the user's project
        const userProjectRequire = require('module').createRequire(packageJsonPath);

        Object.keys(deps).forEach(depName => {
            try {
                // 1. Find the path to the dependency's package.json using the USER'S context
                const depPackageJsonPath = userProjectRequire.resolve(`${depName}/package.json`);
                
                // 2. Load that package.json using the absolute path
                const depPkg = require(depPackageJsonPath);
                const depDir = path.dirname(depPackageJsonPath);

                // 3. Check for SpellCraft metadata
                if (depPkg.spellcraft || depPkg.keywords?.includes("spellcraft-module")) {
                    const jsMainPath = path.join(depDir, depPkg.main || 'index.js');
                    
                    // 4. Load the plugin using the calculated absolute path
                    this.loadPlugin(depName, jsMainPath);
                }
            } catch (e) {
                // Dependency might not be installed or resolvable, skip quietly
                console.warn(`Debug: Could not load potential plugin ${depName}: ${e.message}`);
            }
        });
    }

    loadLocalMagicModules() {
        const localModulesDir = path.join(baseDir, 'spellcraft_modules');
        const generatedDir = path.join(baseDir, '.spellcraft');
        const aggregateFile = path.join(generatedDir, 'modules');

        if (!fs.existsSync(localModulesDir)) {
            // Clean up if it exists so imports fail gracefully if folder is deleted
            if(fs.existsSync(aggregateFile)) fs.unlinkSync(aggregateFile);
            return;
        }

        // Ensure hidden directory exists
        if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

        const jsFiles = fs.readdirSync(localModulesDir).filter(f => f.endsWith('.js'));
        
        let jsonnetContentParts = [];

        jsFiles.forEach(file => {
            const moduleName = path.basename(file, '.js');
            const fullPath = path.join(localModulesDir, file);
            
            let moduleExports;
            try {
                // Cache busting for dev speed
                delete require.cache[require.resolve(fullPath)];
                moduleExports = require(fullPath);
            } catch (e) {
                console.warn(`[!] Error loading local module ${file}: ${e.message}`);
                return;
            }

            let fileMethods = [];

            Object.keys(moduleExports).forEach(funcName => {
                if (funcName === '_spellcraft_metadata') return; // Skip metadata

                let func, params;
                // Handle [func, "arg1", "arg2"] syntax or plain function
                if (Array.isArray(moduleExports[funcName])) {
                    [func, ...params] = moduleExports[funcName];
                } else if (typeof moduleExports[funcName] === 'function') {
                    func = moduleExports[funcName];
                    // You'll need the getFunctionParameterList helper from before
                    params = getFunctionParameterList(func); 
                } else {
                    return;
                }

                // Register with a unique local prefix
                const uniqueId = `local_${moduleName}_${funcName}`;
                this.addNativeFunction(uniqueId, func, ...params);

                // Create the Jsonnet wrapper string
                // e.g. myFunc(a, b):: std.native("local_utils_myFunc")(a, b)
                const paramStr = params.join(", ");
                fileMethods.push(`    ${funcName}(${paramStr}):: std.native("${uniqueId}")(${paramStr})`);
            });

            console.log(`[+] Loaded [${Object.keys(moduleExports).join(", ")}] from [${file}].`);

            if (fileMethods.length > 0) {
                jsonnetContentParts.push(`  ${moduleName}: {\n${fileMethods.join(",\n")}\n  }`);
            }
        });

        // Generate the file
        const finalContent = "{\n" + jsonnetContentParts.join(",\n") + "\n}";
        fs.writeFileSync(aggregateFile, finalContent, 'utf-8');
    }

    loadPlugin(packageName, jsMainPath) {
        if (!jsMainPath || !fs.existsSync(jsMainPath)) return;

        if (this.loadedPlugins.has(packageName)) {
            return;
        }

        let moduleExports;
        try {
            moduleExports = require(jsMainPath);
        } catch (e) {
            console.warn(`[!] Failed to load plugin ${packageName}: ${e.message}`);
            return;
        }

        if (moduleExports._spellcraft_metadata) {
            this.extendWithModuleMetadata(moduleExports._spellcraft_metadata);

            this.loadedPlugins.set(packageName, {
                name: packageName,
                requires: moduleExports._spellcraft_metadata.requires || []
            });
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

    loadPluginsRecursively(currentDir) {
        const packageJsonPath = path.join(currentDir, 'package.json');
        
        // If we've already scanned this specific directory, stop (Circular Dep protection)
        if (this.visitedPlugins.has(packageJsonPath)) return;
        this.visitedPlugins.add(packageJsonPath);

        if (!fs.existsSync(packageJsonPath)) return;

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (e) { return; }

        // Combine dependencies (devDeps are usually only relevant at the root, 
        // but we scan both for completeness at the root level).
        // For sub-dependencies, standard 'dependencies' is usually what matters.
        const deps = { ...pkg.dependencies, ...(currentDir === baseDir ? pkg.devDependencies : {}) };

        // Create a resolver anchored to the CURRENT directory.
        // This is crucial: it tells Node "Find dependencies relative to THIS module",
        // not relative to the root project.
        const localResolver = require('module').createRequire(packageJsonPath);

        Object.keys(deps).forEach(depName => {
            try {
                // 1. Resolve where this dependency actually lives on disk
                const depManifestPath = localResolver.resolve(`${depName}/package.json`);
                const depDir = path.dirname(depManifestPath);

                // 2. Load its package.json
                const depPkg = require(depManifestPath);

                // 3. Check if it is a SpellCraft module
                if (depPkg.spellcraft) {
                    
                    // A. Load the Plugin Logic
                    const jsMainPath = path.join(depDir, depPkg.main || 'index.js');
                    this.loadPlugin(depPkg.name, jsMainPath);

                    // B. Recurse!
                    // Now scan *this* dependency's dependencies
                    this.loadPluginsRecursively(depDir);
                }
            } catch (e) {
                // Dependency might be optional or failed to resolve; skip gracefully
                // console.warn(`Debug: Skipped ${depName} from ${currentDir}: ${e.message}`);
            }
        });
    }

    async render(file) {

        if (!this.isInitialized) {
            await this.init();
        }

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

    validatePluginRequirements() {
        for (const [pluginName, data] of this.loadedPlugins.entries()) {
            if (!data.requires || data.requires.length === 0) continue;

            data.requires.forEach(req => {
                if (!this.loadedPlugins.has(req)) {
                    throw new Error(
                        `[SpellCraft Dependency Error] The module '${pluginName}' requires '${req}', ` +
                        `but '${req}' was not found or failed to load. \n` +
                        `    -> Try running: npm install --save ${req}`
                    );
                }
            });
        }
    }
    
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