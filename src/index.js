// ./src/index.js
'use strict';

const fs = require("fs");
const path = require("path");
const yaml = require('js-yaml');
const crypto = require('crypto');
const colors = require('@colors/colors');
const { spawnSync } = require('child_process');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const defaultFileTypeHandlers = {
    // JSON files
    '.*?\.json$': (content) => JSON.stringify(content, null, 4),
    // YAML files
    '.*?\.yaml$': (content) => yaml.dump(content, { indent: 4 }),
    '.*?\.yml$': (content) => yaml.dump(content, { indent: 4 }),
};

const defaultFileHandler = (content) => JSON.stringify(content, null, 4);

exports.SpellFrame = class SpellFrame {

    constructor(options = {}) {
        const defaults = {
            renderPath: "./render",
            modulePath: "./modules",
            cleanBeforeRender: true,
            useDefaultFileHandlers: true
        };

        // Assign options, falling back to defaults
        Object.assign(this, defaults, options);

        this.initFn = [];
        this._cache = {}; // Initialize cache
        this.cliExtensions = [];
        this.currentPackage = this.getCwdPackage();
        this.currentPackagePath = this.getCwdPackagePath();
        this.fileTypeHandlers = (this.useDefaultFileHandlers) ? { ...defaultFileTypeHandlers } : {};
        this.functionContext = {};
        this.lastRender = null;
        this.activePath = null;
        this.loadedModules = [];
        this.modulePath = path.resolve(path.join(process.cwd(), this.modulePath));
        this.magicContent = {}; // { modulefile: [...snippets] }
        this.registeredFunctions = {}; // { modulefile: [...functionNames] }

        this.renderPath = path.resolve(this.currentPackagePath, this.renderPath);
        this.modulePath = path.resolve(this.currentPackagePath, this.modulePath);

        this.jsonnet = new Jsonnet()
            .addJpath(path.join(__dirname, '../lib')) // For core SpellCraft libsonnet files
            .addJpath(this.modulePath); // For dynamically generated module imports

        // Add built-in native functions
        this.addNativeFunction("envvar", (name) => process.env[name] || false, "name");
        this.addNativeFunction("path", () => this.activePath || process.cwd()); // Use activePath if available

        if (!fs.existsSync(this.modulePath)) {
            fs.mkdirSync(this.modulePath, { recursive: true });
        }

        // Clean up the modules on init
        try {
            fs.readdirSync(this.modulePath)
                .map(e => path.join(this.modulePath, e))
                .forEach(e => fs.unlinkSync(e));

        } catch (e) {
            throw new Error(`[!] Could not create/clean up temporary module folder ${path.dirname(this.modulePath).green}: ${e.message.red}`);
        }

        this.loadedModules = this.loadModulesFromPackageList();
        this.loadModulesFromModuleDirectory();

        return this;
    }

    _generateCacheKey(functionName, args) {
        return crypto.createHash('sha256').update(JSON.stringify([functionName, ...args])).digest('hex');
    }

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

    addJpath(jpath) {
        this.jsonnet = this.jsonnet.addJpath(jpath);
        return this;
    }

    async init() {
        for (const step of this.initFn) {
            await step.call();
        }
    }

    getCwdPackage() {
        return require(path.resolve(this.getCwdPackagePath(), 'package.json'));
    }

    getCwdPackagePath() {
        let depth = 0;
        const maxdepth = 3
        let checkPath = process.cwd();

        while (!fs.existsSync(path.join(checkPath, 'package.json')) && depth < maxdepth) {
            path = path.join(checkPath, '..');
            depth++;
        }

        if (fs.existsSync(path.join(checkPath, 'package.json'))) {
            return checkPath;
        }

        return false;
    }

    getModulePackage(name) {
        // For backwards compatability
        if (name == '..') {
            return this.currentPackage;
        }

        return require(require.resolve(name, { paths: [this.currentPackagePath] }));
    }

    getModulePackagePath(name) {
        // For backwards compatability
        if (name == '..') {
            return this.currentPackagePath;
        }

        return path.dirname(require.resolve(name, { paths: [this.currentPackagePath] }));
    }

    loadFunctionsFromFile(file, as) {
        
        const moduleExports = require(file);

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
                }

                if (typeof func !== 'function') {
                    console.warn(`[!] Export '${funcName}' in module ${file} is not a valid function for native binding.`);
                    return null;
                }
                
                // For `modules` to provide convenient wrappers:
                // e.g. myNativeFunc(a,b):: std.native('myNativeFunc')(a,b)
                const paramString = params.join(', ');
                magicContentSnippets.push(`\t${funcName}(${paramString}):: std.native('${funcName}')(${paramString})`);

                this.addNativeFunction(funcName, func, ...params);
                return funcName;
            }).filter(Boolean); // Remove nulls from skipped items

        this.registeredFunctions[as] = registeredFunctionNames;
        this.magicContent[as] = magicContentSnippets;

        return this;
    }

    loadModulesFromPackageList() {
        const packagesConfigPath = path.join(this.currentPackagePath, 'spellcraft_modules', 'packages.json');

        if (!fs.existsSync(packagesConfigPath)) {
            // console.log('[+] No spellcraft_modules/packages.json file found. Skipping package-based module import.');
            return [];
        }

        let packages;
        try {
            packages = JSON.parse(fs.readFileSync(packagesConfigPath, 'utf-8'));
        } catch (e) {
            console.error(`[!] Error parsing ${packagesConfigPath.green}: ${e.message.red}. Skipping package-based module import.`);
            return [];
        }
        
        return Object.entries(packages).map(([npmPackageName, moduleKey]) => {
            this.loadModuleByName(moduleKey, npmPackageName);
            return moduleKey;
        });
    }

    loadCurrentPackageAsModule(moduleKey) {
        return this.loadModuleByName(moduleKey, '..');
    }

    loadModuleByName(moduleKey, npmPackageName) {
        const importModuleConfig = this.getModulePackage(npmPackageName);
        const importModulePath = this.getModulePackagePath(npmPackageName);

        this.loadFunctionsFromFile(path.resolve(importModulePath, 'module.js'), moduleKey);
        
        const sourceLibsonnetPath = path.resolve(importModulePath, 'module.libsonnet');
        const targetLibsonnetPath = path.resolve(this.modulePath, `${moduleKey}.libsonnet`);

        if (fs.existsSync(targetLibsonnetPath)) {
            throw new Error(`[!] Module library ${path.basename(targetLibsonnetPath)} already exists. This means there is a conflict with package link names.`);
        }
        
        fs.copyFileSync(sourceLibsonnetPath, targetLibsonnetPath);

        console.log(`[+] Linked ${(npmPackageName == '..') ? 'this package'.green : npmPackageName.green} as ${path.basename(targetLibsonnetPath).green}`);

        return this;
    }

    loadModulesFromFileList(jsModuleFiles, as) {
        let allRegisteredFunctions = [];
        let allMagicContent = [];

        jsModuleFiles.forEach(file => {
            this.loadFunctionsFromFile(file, as);
            console.log(`[+] Loaded [${this.registeredFunctions.join(', ').cyan}] from ${path.basename(file).green} into module.${as.green}`);
        });

        return this;
    }

    loadModulesFromModuleDirectory() {
        const spellcraftModulesPath = path.join(this.currentPackagePath, 'spellcraft_modules');
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

        return this.loadModulesFromFileList(jsModuleFiles, 'modules');
    }

    async importSpellCraftModuleFromNpm(npmPackage, name = false) {
        if (!fs.existsSync(this.getModulePackagePath(npmPackage))) {
            console.log(`[*] Attempting to install ${npmPackage.blue}...`);
            
            const install = spawnSync(`npm`, ['install', '--save', npmPackage], {
                cwd: baseDir,
                stdio: 'inherit'
            });

            if (install.error || install.status !== 0) {
                throw new Error(`Failed to install npm package ${npmPackage.blue}. Error: ${install.error.red || install.stderr.toString().red}`);
            }

            console.log(`[+] Successfully installed ${npmPackage.blue}.`);
        }

        const importModuleConfig = this.getModulePackage(npmPackage).config;
        const currentPackageConfig = this.currentPackage.config;

        if (!name && !!!importModuleConfig?.spellcraft_module_default_name) {
            // console.log("Package config:", moduleJson);
            throw new Error(`[!] No import name specified for ${npmPackage.blue}, and it has no 'spellcraft_module_default_name' in its package.json config.`.red);
        }

        // Only link if this package is not a module itself.
        if (!!!currentPackageConfig?.spellcraft_module_default_name) {

            const packagesDirPath = path.join(this.currentPackagePath, 'spellcraft_modules');
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

            const packagesKey = name || importModuleConfig.spellcraft_module_default_name;
            packages[npmPackage] = packagesKey; // Store the clean package name

            fs.writeFileSync(packagesFilePath, JSON.stringify(packages, null, "\t"));
            console.log(`[+] Linked ${npmPackage} as SpellCraft module '${packagesKey}'`);
            
        } else {
            console.log(`[*] Module installed, but not linked because the current project is also a module.`);
            console.log(`---> You can use the module's JS native functions, or import its JSonnet modules.`);
        }
    }

    async render(file) {
        const absoluteFilePath = path.resolve(file);
        if (!fs.existsSync(absoluteFilePath)) {
            throw new Error(`SpellCraft Render Error: Input file ${absoluteFilePath} does not exist.`);
        }

        this.activePath = path.dirname(absoluteFilePath); // Set active path for relative 'path()' calls

        Object.keys(this.magicContent).forEach(e => {
            fs.writeFileSync(path.join(this.modulePath, e), `{\n${this.magicContent[e].join(",\n")}\n}`, 'utf-8');
            console.log(`[+] Registered native functions [${this.registeredFunctions[e].join(', ').cyan}] to modules.${e.green} `);
        });
        
        console.log(`[+] Evaluating Jsonnet file ${path.basename(absoluteFilePath).green}`);
        this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(absoluteFilePath));
        
        return this.lastRender;
    }

    toString() {
        return this.lastRender ?? null;
    }

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