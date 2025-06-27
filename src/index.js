// ./src/index.js
'use strict';

const fs = require("fs");
const path = require("path");
const yaml = require('js-yaml');
const crypto = require('crypto');
const colors = require('@colors/colors');
const { spawnSync } = require('child_process');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const baseDir = process.cwd();

const thisPackage = JSON.parse(fs.readFileSync("./package.json"));

/**
 * @constant {object} defaultFileTypeHandlers
 * @description Default handlers for different file types based on their extensions.
 * Each key is a regex string to match filenames, and the value is a function
 * that takes the file content (as a JavaScript object/value) and returns a string.
 */
const defaultFileTypeHandlers = {
    // JSON files
    '.*?\.json$': (content) => JSON.stringify(content, null, 4),
    // YAML files
    '.*?\.yaml$': (content) => yaml.dump(content, { indent: 4 }),
    '.*?\.yml$': (content) => yaml.dump(content, { indent: 4 }),
};

/**
 * Default file handler used when no specific handler matches the file type.
 * @param {*} content - The content to be stringified.
 * @returns {string} The content stringified as JSON with an indent of 4.
 */
const defaultFileHandler = (content) => JSON.stringify(content, null, 4);

/**
 * Extracts parameter names from a function signature.
 * Note: This method relies on Function.prototype.toString() and may not be
 * robust for all JavaScript function syntaxes (e.g., minified code,
 * complex destructuring in parameters).
 * @param {Function} func - The function to inspect.
 * @returns {string[]} An array of parameter names.
 */
function getFunctionParameterList(func) {
    let funcStr = func.toString();

    // Remove comments and function body
    funcStr = funcStr.replace(/\/\*[\s\S]*?\*\//g, '') // Multi-line comments
        .replace(/\/\/(.)*/g, '')      // Single-line comments
        .replace(/{[\s\S]*}/, '')      // Function body
        .replace(/=>/g, '')            // Arrow function syntax
        .trim();

    const paramStartIndex = funcStr.indexOf("(") + 1;
    // For arrow functions without parentheses for a single arg, e.g., x => x*x
    // This regex might not be perfect. A more robust parser would be needed for all cases.
    const paramEndIndex = funcStr.lastIndexOf(")");

    if (paramStartIndex === 0 || paramEndIndex === -1 || paramStartIndex >= paramEndIndex) {
        // Handle case for single arg arrow function without parens like `arg => ...`
        // Or if no parameters are found.
        const potentialSingleArg = funcStr.split('=>')[0].trim();
        if (potentialSingleArg && !potentialSingleArg.includes('(') && !potentialSingleArg.includes(')')) {
            return [potentialSingleArg].filter(p => p.length > 0);
        }
        return [];
    }

    const paramsString = funcStr.substring(paramStartIndex, paramEndIndex);
    if (!paramsString.trim()) {
        return [];
    }

    return paramsString.split(",")
        .map(param => param.replace(/=[\s\S]*/g, '').trim()) // Remove default values
        .filter(param => param.length > 0);
}


/**
 * @class SpellFrame
 * @classdesc Manages the rendering of configurations using Jsonnet,
 * allowing extension with JavaScript modules and custom file handlers.
 * @exports SpellFrame
 */
exports.SpellFrame = class SpellFrame {
    /**
     * The path where rendered files will be written.
     * @type {string}
     */
    renderPath;

    /**
     * An array of functions to extend CLI argument parsing (e.g., with yargs).
     * Each function typically takes the yargs instance as an argument.
     * @type {Array<Function>}
     */
    cliExtensions;

    /**
     * If true, the renderPath directory will be cleaned of files matching
     * registered fileTypeHandlers before new files are written.
     * @type {boolean}
     */
    cleanBeforeRender;

    /**
     * An object mapping file extension patterns (regex strings) to handler functions.
     * Handler functions take the evaluated Jsonnet output for a file and return a string.
     * @type {Object<string, Function>}
     */
    fileTypeHandlers;

    /**
     * An array of initialization functions to be run (awaited) before rendering.
     * These are often contributed by SpellCraft modules.
     * @type {Array<Function>}
     */
    initFn;

    /**
     * The Jsonnet instance used for evaluation.
     * @type {Jsonnet}
     */
    jsonnet;

    /**
     * The result of the last successful Jsonnet evaluation.
     * @type {object|null}
     */
    lastRender;

    /**
     * The directory path of the currently active Jsonnet file being processed.
     * @type {string|null}
     */
    activePath;

    /**
     * An object that will be used as `this` context for native functions
     * called from Jsonnet.
     * @type {object}
     */
    functionContext;

    /**
     * If true, default file handlers for .json and .yaml/.yml will be used.
     * @type {boolean}
     */
    useDefaultFileHandlers;

    /**
     * A cache for the results of synchronous native functions called from Jsonnet.
     * @private
     * @type {object}
     */
    _cache;


    /**
     * Creates an instance of SpellFrame.
     * @param {object} [options] - Configuration options.
     * @param {string} [options.renderPath="./render"] - The output directory for rendered files.
     * @param {boolean} [options.cleanBeforeRender=true] - Whether to clean the renderPath before writing.
     * @param {boolean} [options.useDefaultFileHandlers=true] - Whether to include default .json and .yaml handlers.
     */
    constructor(options = {}) {
        const defaults = {
            renderPath: "./render",
            cleanBeforeRender: true,
            useDefaultFileHandlers: true
        };

        // Assign options, falling back to defaults
        Object.assign(this, defaults, options);

        this.initFn = [];
        this._cache = {}; // Initialize cache
        this.cliExtensions = [];
        this.fileTypeHandlers = (this.useDefaultFileHandlers) ? { ...defaultFileTypeHandlers } : {};
        this.functionContext = {};
        this.lastRender = null;
        this.activePath = null;
        this.loadedModules = [];

        this.jsonnet = new Jsonnet()
            .addJpath(path.join(__dirname, '../lib')) // For core SpellCraft libsonnet files
            .addJpath(path.join(__dirname, '../modules')); // For dynamically generated module imports

        // Add built-in native functions
        this.addNativeFunction("envvar", (name) => process.env[name] || false, "name");
        this.addNativeFunction("path", () => this.activePath || process.cwd()); // Use activePath if available

        this.loadedModules = this.loadModulesFromPackageList();
    }

    /**
     * Generates a cache key for native function calls.
     * @private
     * @param {string} functionName - The name of the function.
     * @param {Array<*>} args - The arguments passed to the function.
     * @returns {string} A SHA256 hash representing the cache key.
     */
    _generateCacheKey(functionName, args) {
        return crypto.createHash('sha256').update(JSON.stringify([functionName, ...args])).digest('hex');
    }

    /**
     * Adds a file type handler for a given file pattern.
     * The handler function receives the processed data for a file and should return its string content.
     * @param {string} pattern - A regex string to match filenames.
     * @param {Function} handler - The handler function (content: any) => string.
     * @returns {this} The SpellFrame instance for chaining.
     */
    addFileTypeHandler(pattern, handler) {
        // Making it writable: false by default is a strong choice.
        // If flexibility to override is needed later, this could be a simple assignment.
        Object.defineProperty(this.fileTypeHandlers, pattern, {
            value: handler,
            writable: false, // Or true if overrides should be easy
            enumerable: true,
            configurable: true
        });
        return this;
    }

    /**
     * Adds a native JavaScript function to be callable from Jsonnet.
     * Results of synchronous functions are cached.
     * @param {string} name - The name of the function in Jsonnet.
     * @param {Function} func - The JavaScript function to execute.
     * @param {...string} parameters - The names of the parameters the function expects (for Jsonnet signature).
     * @returns {this} The SpellFrame instance for chaining.
     */
    addNativeFunction(name, func, ...parameters) {
        this.jsonnet.nativeCallback(name, (...args) => {
            const key = this._generateCacheKey(name, args);
            if (this._cache[key] !== undefined) {
                return this._cache[key];
            }

            // Execute the function with `this.functionContext` as its `this` value.
            const result = func.apply(this.functionContext, args);
            this._cache[key] = result;
            return result;
        }, ...parameters);
        return this;
    }

    /**
     * Adds an external string variable to the Jsonnet evaluation context.
     * If the value is not a string, it will be JSON.stringified.
     * @param {string} name - The name of the external variable in Jsonnet.
     * @param {*} value - The value to expose.
     * @returns {this} The SpellFrame instance for chaining.
     */
    addExternalValue(name, value) {
        const finalValue = (typeof value === "string") ? value : JSON.stringify(value);
        this.jsonnet = this.jsonnet.extCode(name, finalValue);
        return this;
    }

    /**
     * Extends SpellFrame's capabilities based on metadata from a module.
     * (Currently a placeholder - implement as needed)
     * @param {object} metadata - The metadata object from a SpellCraft module.
     * @todo Implement the logic for processing module metadata.
     * @returns {this} The SpellFrame instance for chaining.
     */
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

    /**
     * Adds a path to the Jsonnet import search paths (JPATH).
     * @param {string} jpath - The directory path to add.
     * @returns {this} The SpellFrame instance for chaining.
     */
    addJpath(jpath) {
        this.jsonnet = this.jsonnet.addJpath(jpath);
        return this;
    }

    /**
     * Runs all registered initialization functions.
     * @async
     * @returns {Promise<void>}
     */
    async init() {
        for (const step of this.initFn) {
            await step.call();
        }
    }

    /**
     * Imports a SpellCraft module from an npm package.
     * This involves installing the package if not present, reading its package.json
     * for SpellCraft configuration, and linking it for use.
     * @param {string} npmPackage - The name of the npm package (e.g., "my-spellcraft-module" or "@scope/my-module").
     * @param {string} [name=false] - An optional alias name for the module. If false, uses default from package.
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If the package cannot be installed, lacks package.json, or has no import name.
     */
    async importSpellCraftModuleFromNpm(npmPackage, name = false) {
        const npmPath = path.resolve(baseDir, 'node_modules', npmPackage);
        if (!fs.existsSync(npmPath)) {
            console.log(`[+] Attempting to install ${npmPackage}...`);
            
            const install = spawnSync(`npm`, ['install', '--save', npmPackage], { // Using --save-dev for local project context
                cwd: baseDir,
                stdio: 'inherit'
            });

            if (install.error || install.status !== 0) {
                throw new Error(`Failed to install npm package ${npmPackage.blue}. Error: ${install.error.red || install.stderr.toString().red}`);
            }

            console.log(`[+] Successfully installed ${npmPackage.blue}.`);
        }

        const moduleJson = JSON.parse(fs.readFileSync(path.join(npmPath, 'package.json')));
        const moduleConfig = moduleJson.config || moduleJson.spellcraft; // Allow 'spellcraft' key too

        const spellcraftConfig = thisPackage.config || thisPackage.spellcraft; // Allow 'spellcraft' key too

        if (!name && !!!moduleConfig?.spellcraft_module_default_name) {
            console.log("Package config:", moduleJson);
            throw new Error(`[!] No import name specified for ${npmPackage}, and it has no 'spellcraft_module_default_name' in its package.json config.`.red);
        }

        // Only link if this package is not a module itself.
        if (!!!spellcraftConfig?.spellcraft_module_default_name) {

            const packagesDirPath = path.join(baseDir, 'spellcraft_modules');
            if (!fs.existsSync(packagesDirPath)) {
                fs.mkdirSync(packagesDirPath, { recursive: true });
            }

            const packagesFilePath = path.join(packagesDirPath, 'packages.json');
            let packages = {};
            if (fs.existsSync(packagesFilePath)) {
                try {
                    packages = JSON.parse(fs.readFileSync(packagesFilePath, 'utf-8'));
                } catch (e) {
                    console.warn(`[!] Could not parse existing ${packagesFilePath}. Starting fresh. Error: ${e.message}`.red);
                    packages = {};
                }
            }

            // Derive the base name to store (e.g., "my-package" from "my-package@1.0.0")
            const npmPackageBaseName = npmPackage.startsWith("@") ?
                `@${npmPackage.split('/')[1].split('@')[0]}` : // Handles @scope/name and @scope/name@version
                npmPackage.split('@')[0]; // Handles name and name@version

            const packagesKey = name || moduleConfig.spellcraft_module_default_name;
            packages[npmPackage] = packagesKey; // Store the clean package name

            fs.writeFileSync(packagesFilePath, JSON.stringify(packages, null, "\t"));
            console.log(`[+] Linked ${npmPackage} as SpellCraft module '${packagesKey}'`);
            
        } else {
            console.log(`[+] Module installed, but not linked because the current project is also a module.`);
            console.log(`    You can use the module's JS native functions, or import its JSonnet modules.`);
        }
    }

    /**
     * Evaluates a Jsonnet file and stores the result.
     * This also sets up the dynamic `modules/modules` import aggregator.
     * @param {string} file - The path to the main Jsonnet file to evaluate.
     * @async
     * @returns {Promise<object>} The parsed JSON object from the Jsonnet evaluation.
     * @throws {Error} If the file doesn't exist or if Jsonnet parsing fails.
     */
    async render(file) {
        const absoluteFilePath = path.resolve(file);
        if (!fs.existsSync(absoluteFilePath)) {
            throw new Error(`SpellCraft Render Error: Input file ${absoluteFilePath} does not exist.`);
        }

        this.activePath = path.dirname(absoluteFilePath); // Set active path for relative 'path()' calls

        // Path to the dynamically generated libsonnet file that imports all modules
        const dynamicModulesImportFile = path.resolve(__dirname, '../modules/modules');

        if (fs.existsSync(dynamicModulesImportFile)) {
            fs.unlinkSync(dynamicModulesImportFile);
        }
        
        const { magicContent, registeredFunctions } = this.loadModulesFromModuleDirectory(dynamicModulesImportFile);

        const aggregateFileDir = path.dirname(dynamicModulesImportFile);
        if (!fs.existsSync(aggregateFileDir)) {
            fs.mkdirSync(aggregateFileDir, { recursive: true });
        }

        magicContent.push(this.loadedModules.flatMap(e => {
            return `\t${e}: import '${e}.libsonnet',`
        }));

        fs.writeFileSync(dynamicModulesImportFile, `{\n${magicContent.join(",\n")}\n}`, 'utf-8');

        if (registeredFunctions.length > 0) {
             console.log(`[+] Registered ${registeredFunctions.length} native function(s): [ ${registeredFunctions.sort().join(', ').cyan} ]`);
        }

        if (magicContent.length > 0) {
            console.log(`[+] Aggregated modules written to '${path.basename(dynamicModulesImportFile).green}'`);
        }

        // Ensure renderPath does not have a trailing slash for consistency
        if (this.renderPath.endsWith(path.sep)) {
            this.renderPath = this.renderPath.slice(0, -1);
        }

        console.log(`[+] Evaluating Jsonnet file ${path.basename(absoluteFilePath).green}`);
        this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(absoluteFilePath));

        // Clean up the modules folder after rendering,
        // as it's specific to this render pass and its discovered modules.
        try {
            const modulePath = path.resolve(__dirname, '../modules');

            fs.readdirSync(modulePath)
                .map(e => path.join(modulePath, e))
                .forEach(e => fs.unlinkSync(e));

        } catch (e) {
            console.warn(`[!] Could not clean up temporary module file ${dynamicModulesImportFile}: ${e.message}`);
        }
        
        return this.lastRender;
    }

    /**
     * Loads SpellCraft modules by scanning the `spellcraft_modules` directory for `.js` files.
     * @returns {Object} A list of registered function names from the loaded modules.
     */
    loadModulesFromModuleDirectory() {
        const spellcraftModulesPath = path.join(baseDir, 'spellcraft_modules');
        if (!fs.existsSync(spellcraftModulesPath)) {
            return { registeredFunctions: [], magicContent: [] };
        }

        const spellcraftConfig = thisPackage.config || thisPackage.spellcraft; // Allow 'spellcraft' key too

        if (!!spellcraftConfig?.spellcraft_module_default_name) {
            console.log("[-] This package is a SpellCraft module. Skipping directory-based module import.");
            return { registeredFunctions: [], magicContent: [] };
        }

        const jsModuleFiles = fs.readdirSync(spellcraftModulesPath)
            .filter(f => f.endsWith('.js')) // Simpler check for .js files
            .map(f => path.join(spellcraftModulesPath, f));

        return this.loadModulesFromFileList(jsModuleFiles);
    }


    /**
     * Loads SpellCraft module configurations and functions from `spellcraft_modules/packages.json`.
     * This involves reading linked npm packages and setting them up.
     * @returns {Array<string>} A list of module keys that were loaded.
     */
    loadModulesFromPackageList() {
        const packagesConfigPath = path.join(baseDir, 'spellcraft_modules', 'packages.json');

        if (!fs.existsSync(packagesConfigPath)) {
            // console.log('[+] No spellcraft_modules/packages.json file found. Skipping package-based module import.');
            return [];
        }

        let packages;
        try {
            packages = JSON.parse(fs.readFileSync(packagesConfigPath, 'utf-8'));
        } catch (e) {
            console.error(`[!] Error parsing ${packagesConfigPath}: ${e.message}. Skipping package-based module import.`);
            return [];
        }
        
        return Object.entries(packages).map(([npmPackageName, moduleKey]) => {
            return this.loadModuleByName(moduleKey, npmPackageName);
        }); // Filter out any undefined results if a module fails to load
    }

    /**
     * Loads a specific module by its registered key and npm package name.
     * @private
     * @param {string} moduleKey - The key (alias) under which the module is registered.
     * @param {string} npmPackageName - The actual npm package name.
     * @returns {string|false} The moduleKey if successful, false otherwise.
     */
    loadModuleByName(moduleKey, npmPackageName) {
        const packageJsonPath = path.join(baseDir, 'node_modules', npmPackageName, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            console.trace(`[!] package.json not found for module '${moduleKey}' (package: ${npmPackageName}) at ${packageJsonPath}. Skipping.`);
            return false;
        }

        let packageConfig;
        try {
            packageConfig = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (e) {
            console.warn(`[!] Error parsing package.json for module '${moduleKey}' (package: ${npmPackageName}): ${e.message}. Skipping.`);
            return false;
        }

        if (!packageConfig.main) {
            console.warn(`[!] 'main' field missing in package.json for module '${moduleKey}' (package: ${npmPackageName}). Skipping JS function loading.`.red);
        } else {
            const jsMainFilePath = path.resolve(baseDir, 'node_modules', npmPackageName, packageConfig.main);
            if (fs.existsSync(jsMainFilePath)) {
                const { functions } = this.loadFunctionsFromFile(jsMainFilePath);
                if (functions.length > 0) {
                    console.log(`[+] Imported JavaScript native [${functions.join(', ').cyan}] from module ${moduleKey.green}`);
                }
            } else {
                console.warn(`[!] Main JS file '${jsMainFilePath.red}' not found for module '${moduleKey.red}'. Skipping JS function loading.`);
            }
        }
        

        // Define where the module's .libsonnet file (if any) should be copied to be found by Jsonnet
        // It will be copied to `../modules/<moduleKey>.libsonnet` (relative to this file)
        const targetLibsonnetPath = path.resolve(__dirname, '..', 'modules', `${moduleKey}.libsonnet`);
        
        // Check for `module.libsonnet` or a path specified in package.json (e.g., spellcraft.libsonnet_module)
        let sourceLibsonnetPath;
        const spellcraftConfig = packageConfig.config || packageConfig.spellcraft;
        if (spellcraftConfig?.libsonnet_module) {
            sourceLibsonnetPath = path.resolve(baseDir, 'node_modules', npmPackageName, spellcraftConfig.libsonnet_module);
        } else {
            // Default to 'module.libsonnet' in the package's root or main file's directory
            const defaultLibsonnetName = 'module.libsonnet';
            const packageRootDir = path.resolve(baseDir, 'node_modules', npmPackageName);
            sourceLibsonnetPath = path.join(packageRootDir, defaultLibsonnetName);
            if (!fs.existsSync(sourceLibsonnetPath) && packageConfig.main) {
                 sourceLibsonnetPath = path.join(path.dirname(path.resolve(packageRootDir, packageConfig.main)), defaultLibsonnetName);
            }
        }

        if (fs.existsSync(sourceLibsonnetPath)) {
            try {
                // Ensure the target directory exists
                fs.mkdirSync(path.dirname(targetLibsonnetPath), { recursive: true });
                fs.copyFileSync(sourceLibsonnetPath, targetLibsonnetPath);
                
                console.log(`[+] Linked libsonnet module for ${npmPackageName == '..' ? 'this package'.blue : npmPackageName.green} as modules.${moduleKey.green}`);
            } catch (e) {
                console.warn(`[!] Failed to copy libsonnet module for '${moduleKey}': ${e.message}`);
            }
        } else {
            // console.log(`[+] No .libsonnet module found for '${moduleKey}' at expected paths.`);
        }

        return moduleKey;
    }


    /**
     * Loads native functions from a list of JavaScript module files and generates
     * an aggregate Jsonnet import file (`modules` by default convention).
     * @param {string[]} jsModuleFiles - An array of absolute paths to JS module files.
     * @param {string} aggregateModuleFile - The path to the Jsonnet file that will aggregate imports.
     * @returns {{registeredFunctions: string[], magicContent: string[]}}
     *          An object containing lists of registered function names and the Jsonnet "magic" import strings.
     */
    loadModulesFromFileList(jsModuleFiles) {
        let allRegisteredFunctions = [];
        let allMagicContent = [];

        jsModuleFiles.forEach(file => {
            try {
                const { functions, magic } = this.loadFunctionsFromFile(file);
                allRegisteredFunctions.push(...functions);
                allMagicContent.push(...magic);
            } catch (e) {
                console.warn(`[!] Failed to load functions from module ${file}: ${e.message}`);
            }
        });

        return { registeredFunctions: allRegisteredFunctions, magicContent: allMagicContent };
    }


    /**
     * Loads functions and metadata from a single JavaScript module file.
     * Registers functions as native callbacks in Jsonnet and processes SpellCraft metadata.
     * @param {string} file - Absolute path to the JavaScript module file.
     * @returns {{functions: string[], magic: string[]}} Registered function names and "magic" Jsonnet strings for them.
     * @throws {Error} If the file cannot be required.
     */
    loadFunctionsFromFile(file) {
        let moduleExports;
        try {
            // Bust require cache for potentially updated modules during a session (e.g. dev mode)
            delete require.cache[require.resolve(file)];
            moduleExports = require(file);
        } catch (e) {
            throw new Error(`SpellCraft Error: Could not require module ${file}. ${e.message}`);
        }

        const magicContentSnippets = [];
        if (moduleExports._spellcraft_metadata) {
            this.extendWithModuleMetadata(moduleExports._spellcraft_metadata);
        }

        const registeredFunctionNames = Object.keys(moduleExports)
            .filter(key => key !== '_spellcraft_metadata' && typeof moduleExports[key] !== 'undefined')
            .map(funcName => {
                let func, params;

                if (typeof moduleExports[funcName] === "object" && Array.isArray(moduleExports[funcName])) {
                    // Expects [function, paramName1, paramName2, ...]
                    [func, ...params] = moduleExports[funcName];
                } else if (typeof moduleExports[funcName] === "function") {
                    func = moduleExports[funcName];
                    params = getFunctionParameterList(func); // Auto-detect params
                } else {
                    // console.warn(`[!] Skipping non-function export '${funcName}' in module ${file}.`);
                    return null; // Skip if not a function or recognized array structure
                }

                if (typeof func !== 'function') {
                    // console.warn(`[!] Export '${funcName}' in module ${file} is not a valid function for native binding.`);
                    return null;
                }
                
                // For `modules` to provide convenient wrappers:
                // e.g. myNativeFunc(a,b):: std.native('myNativeFunc')(a,b)
                const paramString = params.join(', ');
                magicContentSnippets.push(`  ${funcName}(${paramString}):: std.native('${funcName}')(${paramString})`);

                this.addNativeFunction(funcName, func, ...params);
                return funcName;
            }).filter(Boolean); // Remove nulls from skipped items

        return { functions: registeredFunctionNames, magic: magicContentSnippets };
    }

    /**
     * Returns the string representation of the last render, or null.
     * By default, this might return the object itself if `lastRender` is an object.
     * @returns {object|string|null} The last rendered output, or null if no render has occurred.
     */
    toString() {
        return this.lastRender ?? null; // If lastRender is an object, it returns the object.
                                        // If a string is always desired, use JSON.stringify or similar.
    }

    /**
     * Writes the rendered files to the configured `renderPath`.
     * Applies appropriate file handlers based on filename patterns.
     * @param {object} [filesToWrite=this.lastRender] - An object where keys are filenames
     *        and values are the content (typically from Jsonnet evaluation).
     * @returns {this} The SpellFrame instance for chaining.
     * @throws {Error} If `renderPath` cannot be created or files cannot be written.
     */
    write(filesToWrite = this.lastRender) {
        if (!filesToWrite || typeof filesToWrite !== 'object' || Object.keys(filesToWrite).length === 0) {
            console.log("[+] No files to write from the last render or provided input.");
            return this;
        }

        try {
            if (!fs.existsSync(this.renderPath)) {
                fs.mkdirSync(this.renderPath, { recursive: true });
            }
        } catch (e) {
            throw new Error(`SpellCraft Write Error: renderPath '${this.renderPath}' could not be created. ${e.message}`);
        }

        if (this.cleanBeforeRender) {
            console.log(`[+] Cleaning render path: ${this.renderPath}`);
            try {
                Object.keys(this.fileTypeHandlers).forEach(regexPattern => {
                    const regex = new RegExp(regexPattern, "i"); // Case-insensitive match
                    fs.readdirSync(this.renderPath)
                        .filter(f => regex.test(f))
                        .forEach(f => {
                            const filePathToClean = path.join(this.renderPath, f);
                            try {
                                fs.unlinkSync(filePathToClean);
                                // console.log(`  - Removed ${filePathToClean}`);
                            } catch (cleanError) {
                                console.warn(`  [!] Failed to remove ${filePathToClean}: ${cleanError.message}`);
                            }
                        });
                });
            } catch (e) {
                // This error is for readdirSync itself, less likely but possible
                throw new Error(`SpellCraft Clean Error: Failed to read/clean files from renderPath '${this.renderPath}'. ${e.message}`);
            }
        }

        console.log(`[+] Writing files to: ${this.renderPath}`);
        try {
            for (const filename in filesToWrite) {
                if (Object.prototype.hasOwnProperty.call(filesToWrite, filename)) {
                    const outputFilePath = path.join(this.renderPath, filename);
                    const fileContent = filesToWrite[filename];

                    // Find the appropriate handler or use default
                    const [, handlerFn] = Object.entries(this.fileTypeHandlers)
                        .find(([pattern]) => new RegExp(pattern).test(filename)) || [null, defaultFileHandler];

                    try {
                        const processedContent = handlerFn(fileContent);
                        fs.writeFileSync(outputFilePath, processedContent, 'utf-8');
                        console.log(`  -> ${path.basename(outputFilePath).green}`);
                    } catch (handlerError) {
                         console.error(`  [!] Error processing or writing file ${filename}: ${handlerError.message}`);
                         // Optionally re-throw or collect errors
                    }
                }
            }
        } catch (e) {
            // This would catch errors in the loop structure itself, less likely for file operations
            throw new Error(`SpellCraft Write Error: Failed during file writing loop. ${e.message}`);
        }

        return this;
    }
};