'use strict';

const fs = require("fs");
const path = require("path");
const yaml = require('js-yaml');
const crypto = require('crypto');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const EventEmitter = require("events");

// Writes text through untouched. Anything that isn't already a string still has
// to become one, so it falls back to JSON rather than stringifying to
// "[object Object]".
const verbatim = (content) => (typeof content === "string" ? content : JSON.stringify(content, null, 4));

// Note the doubled backslash: these are JS strings compiled to RegExp, so '\.'
// would reach the pattern as a bare '.' and match any character.
const defaultFileTypeHandlers = {
    '.*?\\.json$': (content) => JSON.stringify(content, null, 4),
    '.*?\\.yaml$': (content) => yaml.dump(content, { indent: 4 }),
    '.*?\\.yml$': (content) => yaml.dump(content, { indent: 4 }),
    '.*?\\.md$': verbatim,
    '.*?\\.txt$': verbatim,
};

// An extension with no registered handler is written verbatim rather than
// JSON-encoded, so a plugin-free manifest can still emit arbitrary text (a
// shell script, an HCL file with no plugin claiming .tf, ...) by simply
// naming the key. Non-strings still fall back to JSON rather than
// "[object Object]".
const defaultFileHandler = verbatim;

// Module-level, shared by every SpellFrame in the process -- deliberately not
// per-instance. Some plugins keep native-side state in a plain module-level
// object rather than in `functionContext` (aws-terraform's `projectName`,
// discovered once via `bootstrap()` and read by every later `getArtifact()`/
// `putArtifact()` call, is the motivating case) -- and some go further still:
// `gcp-auth`'s credentials are handed to the `googleapis` library itself via
// `google.options({ auth })`, a mutation of a singleton that library owns,
// read back live on every request. Either way, the state is shared by every
// SpellFrame that loads the plugin in this process, so two renders running at
// the same time can interleave their writes to it -- not a Jsonnet-laziness
// ordering hazard within one render, which is what `assertions::` and
// explicit data-dependencies address, but genuine cross-render contamination.
// Confirmed directly: two frames racing `init()` alone -- before either one's
// Jsonnet evaluation even starts -- can leave a frame authenticated as the
// *other* frame's identity, silently.
//
// A native call's entire async body -- everything it awaits -- resolves
// before evaluateFile()/evaluateSnippet()'s own promise does (Jsonnet's
// evaluation of one file runs on a single thread, and its native-call bridge
// blocks that thread until the JS side's promise settles). So it's enough to
// serialize every call into this queue -- init() included, since a plugin's
// init hook makes exactly the same kind of native-adjacent calls evaluation
// does -- and no two renders' or two inits' native calls can ever overlap,
// full stop, regardless of what state any plugin keeps or how.
//
// The cost is real and worth stating plainly: renders (and the init that
// precedes each one) in one process become fully serial, not just correctly
// ordered. A slow render blocks every other render queued behind it, even one
// sharing no plugins with it at all. For the CLI (one process, one manifest,
// one render) this costs nothing. An embedder doing genuinely concurrent
// high-throughput rendering would feel it -- finer-grained locking (only
// serializing renders that share a loaded plugin) is the natural next step
// if that ever matters, but isn't built here.
let executionQueue = Promise.resolve();

function serialized(fn) {
    const result = executionQueue.then(fn, fn);
    // However this turn comes out, the queue itself must stay healthy for the
    // next one -- a rejection here must not wedge everything behind it.
    executionQueue = result.then(() => {}, () => {});
    return result;
}

// Every existing node_modules directory from `from` up to the filesystem root,
// nearest first -- the same set, in the same order, that Node's own resolver
// would consult.
function nodeModulesPaths(from) {
    const found = [];

    let current = path.resolve(from);

    while (true) {
        if (path.basename(current) !== 'node_modules') {
            const candidate = path.join(current, 'node_modules');
            if (fs.existsSync(candidate)) found.push(candidate);
        }

        const parent = path.dirname(current);
        if (parent === current) return found;

        current = parent;
    }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Walks source from `start`, tracking quotes and nesting, and returns the index
// of the delimiter that closes the one at `start`.
function findClosingDelimiter(source, start) {
    let depth = 0;
    let quote = null;

    for (let i = start; i < source.length; i++) {
        const char = source[i];

        if (quote) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;
            continue;
        }

        if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }

    return -1;
}

// Splits a parameter list on the commas that separate parameters, ignoring any
// that appear inside a default value's own parentheses, brackets or strings.
function splitParameters(source) {
    const parameters = [];

    let current = '';
    let depth = 0;
    let quote = null;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];

        if (quote) {
            current += char;
            if (char === '\\') current += source[++i] ?? '';
            else if (char === quote) quote = null;
            continue;
        }

        if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
        else if (char === ',' && depth === 0) {
            parameters.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    parameters.push(current);

    return parameters;
}

// Recovers the parameter names of a function that was exported bare, so that
// Jsonnet can be told what to call them.
//
// This reads the function's own source, which only works for source the author
// wrote by hand. Anything ambiguous -- a destructured or computed parameter, or
// minified source -- raises rather than guessing, because a wrong name here
// surfaces much later as a confusing Jsonnet error at the call site. Exporting
// as [fn, "arg1", "arg2"] states the names outright and always wins.
function getFunctionParameterList(func, label) {
    const source = func.toString();
    const name = label || func.name || 'an exported function';

    // `x => ...` is the only form whose parameter carries no parentheses.
    const bare = source.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
    if (bare) return [bare[1]];

    const open = source.indexOf('(');
    if (open === -1) return [];

    const close = findClosingDelimiter(source, open);
    if (close === -1) return [];

    const parameters = splitParameters(source.slice(open + 1, close))
        .map(parameter => parameter.split('=')[0].trim())
        .filter(parameter => parameter.length > 0)
        // Jsonnet has no variadic call, so a rest parameter has nothing to bind
        // to. Dropping it leaves the named leading parameters reachable.
        .filter(parameter => !parameter.startsWith('...'));

    const unusable = parameters.find(parameter => !IDENTIFIER.test(parameter));

    if (unusable) {
        throw new Error(
            `[SpellCraft] Could not read the parameter names of '${name}' ('${unusable}' is not a plain name).\n` +
            `    Export it as [fn, "arg1", "arg2"] to name its parameters explicitly.`
        );
    }

    return parameters;
}

exports.SpellFrame = class SpellFrame extends EventEmitter {
    constructor(options = {}) {
        super();
        const defaults = {
            // Captured per instance, at construction time -- not once at module
            // load, so a caller that constructs more than one SpellFrame against
            // different directories (tests; anything embedding SpellFrame as a
            // library) gets the cwd it actually asked for rather than whatever
            // was current when this file was first required.
            baseDir: process.cwd(),
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
        this.functionContext.spellframe = this;
        this.lastRender = null;
        this.activePath = null;
        this.visitedPlugins = new Set();
        this.loadedPlugins = new Map();
        this.isInitialized = false;
        this._jpaths = new Set();

        this.jsonnet = new Jsonnet();
        this.addJpathOnce(path.join(__dirname, '../lib'));

        // Jsonnet imports name packages the same way `require` does, so they have
        // to resolve the same way: nearest node_modules first, then each ancestor.
        // Only checking the working directory breaks under npm workspaces, where
        // dependencies are hoisted to the workspace root rather than installed
        // beside the package importing them.
        for (const modulesDir of nodeModulesPaths(this.baseDir)) {
            this.addJpathOnce(modulesDir);
        }

        this.addJpathOnce(path.join(this.baseDir, '.spellcraft'));

        // Built-in native functions
        this.addNativeFunction("envvar", (name) => process.env[name] || false, "name");
        this.addNativeFunction("path", () => this.activePath || process.cwd());

        // REFACTOR: Automatically find and register plugins from package.json
        this.loadPluginsFromDependencies();
        this.loadPluginsRecursively(this.baseDir);
        this.validatePluginRequirements();

        // 2. Load Local Magic Modules (Rapid Prototyping Mode)
        this.loadLocalMagicModules();
    }

    _generateCacheKey(functionName, args) {
        return crypto.createHash('sha256').update(JSON.stringify([functionName, ...args])).digest('hex');
    }

    // Adds a Jsonnet library search path, skipping it if already present. Called
    // often -- once per node_modules ancestor of every plugin loaded -- and a
    // workspace has most plugins sharing the same physical root, so without the
    // dedup, jpath would grow by that many redundant entries per plugin.
    addJpathOnce(dir) {
        if (this._jpaths.has(dir)) return;
        this._jpaths.add(dir);
        this.jsonnet = this.jsonnet.addJpath(dir);
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

    async emitAsync(event, ...args) {
        const listeners = this.listeners(event);
        for (const listener of listeners) {
            await listener(...args);
        }
    }

    addNativeFunction(name, func, ...parameters) {
        this.jsonnet.nativeCallback(name, (...args) => {
            const key = this._generateCacheKey(name, args);
            if (this._cache[key] !== undefined) {
                return this._cache[key];
            }
            const result = func.apply(this.functionContext, args);
            this._cache[key] = result;
            this.emit(name, ...args);
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

        // Serialized against every other SpellFrame's init() and evaluation in
        // this process -- see the comment on executionQueue for why. Re-check
        // isInitialized once inside: two calls to init() on this *same* frame
        // could both pass the guard above before either reaches the queue, and
        // the second one through must not repeat the first's work.
        await serialized(async () => {
            if (this.isInitialized) return;

            for (const step of this.initFn) {
                await step(this);
            }

            this.isInitialized = true;
        });
    }

    loadPluginsFromDependencies() {
        const packageJsonPath = path.join(this.baseDir, 'package.json');
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
                // Most dependencies aren't plugins, and some don't expose their
                // package.json through 'exports' at all. Neither is worth reporting.
                // Set SPELLCRAFT_DEBUG to see what was skipped.
                if (process.env.SPELLCRAFT_DEBUG) {
                    console.warn(`Debug: Could not load potential plugin ${depName}: ${e.message}`);
                }
            }
        });
    }

    loadLocalMagicModules() {
        const localModulesDir = path.join(this.baseDir, 'spellcraft_modules');
        const generatedDir = path.join(this.baseDir, '.spellcraft');
        const aggregateFile = path.join(generatedDir, 'modules');

        if (!fs.existsSync(localModulesDir)) {
            // Clean up if it exists so imports fail gracefully if folder is deleted
            if (fs.existsSync(aggregateFile)) fs.unlinkSync(aggregateFile);
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
                    params = getFunctionParameterList(func, `${file}:${funcName}`);
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

            // A plugin's own module.libsonnet can `import` another package by
            // name, the same way this file's module.js just required one with
            // `require()`. require() resolves that by walking up from the
            // plugin's real location on disk -- which is why it works even when
            // the plugin is only a transitive dependency, reached through a
            // symlink (npm workspaces, `file:`, `npm link`). Jsonnet's import
            // has no per-file equivalent; it only ever searches `jpath`, which
            // until now only ever covered the *consumer's* node_modules
            // ancestry. A plugin's own import then resolved only by accident,
            // when the consumer happened to also carry that dependency
            // (hoisting under a plain registry install papers over this, which
            // is why it surfaces only in linked-development setups). Adding the
            // plugin's own ancestry closes the gap; realpath first, since the
            // walk has to follow the symlink to mean anything.
            const pluginRealDir = fs.realpathSync(path.dirname(jsMainPath));
            for (const modulesDir of nodeModulesPaths(pluginRealDir)) {
                this.addJpathOnce(modulesDir);
            }
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
                params = getFunctionParameterList(func, `${packageName}:${key}`);
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
        const deps = { ...pkg.dependencies, ...(currentDir === this.baseDir ? pkg.devDependencies : {}) };

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

    // Both render() and renderString() funnel through here so a hidden
    // top-level `assertions::` field is guaranteed to run before anything is
    // written -- the conventional place for a manifest to put an
    // aws.assertIdentity()/gcp.assertProject() style guard.
    //
    // Hidden fields are invisible to manifestation: Jsonnet only walks and
    // serialises visible ones, so a lazy `assertions::` field only ever ran if
    // its value happened to be threaded into something visible too (returning
    // it into `allowed_account_ids`, say). Get that threading wrong -- the
    // easier mistake -- and the guard fails open, silently, which is the one
    // thing an assertion must never do.
    //
    // The fix doesn't need Jsonnet to do anything it doesn't already do: read
    // the hidden field through a *visible* field of a throwaway wrapper
    // object, and let ordinary manifestation force it, the same way it forces
    // every other visible field. A failing `assert` inside `assertions::`
    // throws while that wrapper is being manifested, before a single file is
    // written -- and the wrapper itself is discarded here, so a manifest's own
    // author never sees it.
    async evaluateManifestExpression(expression) {
        const wrapper = `local __spellcraft_manifest__ = (${expression});\n` +
            `{\n` +
            `    manifest: __spellcraft_manifest__,\n` +
            `    assertions: if std.isObject(__spellcraft_manifest__) && std.objectHasAll(__spellcraft_manifest__, "assertions")\n` +
            `        then __spellcraft_manifest__.assertions\n` +
            `        else null,\n` +
            `}`;

        // Serialized process-wide -- see the comment on executionQueue for why.
        const evaluated = await serialized(async () => {
            return JSON.parse(await this.jsonnet.evaluateSnippet(wrapper));
        });

        return evaluated.manifest;
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
            this.lastRender = await this.evaluateManifestExpression(`import ${JSON.stringify(absoluteFilePath)}`);
        } catch (e) {
            throw new Error(`Jsonnet Evaluation Error: ${e.message || e}`);
        }

        this.emit('render', this.lastRender);
        return this.lastRender;
    }

    async renderString(snippet) {

        this.activePath = process.cwd();

        try {
            this.lastRender = await this.evaluateManifestExpression(snippet);
        } catch (e) {
            throw new Error(`Jsonnet Evaluation Error: ${e.message || e}`);
        }

        this.emit('render', this.lastRender);
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

    // Where write() stashes the list of filenames it produced last time, so a
    // later clean can remove exactly those rather than sweeping render/ for
    // anything that merely matches a registered extension. A subdirectory, not
    // a top-level file: Terraform only reads files directly in render/, not
    // subdirectories, so this is invisible to it regardless of the leading
    // dot.
    get manifestPath() {
        return path.join(this.renderPath, '.spellcraft', 'manifest.json');
    }

    // Deletes exactly what the previous write() produced, per the manifest it
    // left behind -- not everything in render/ that happens to match a
    // registered pattern. A hand-written file that merely shares an extension
    // with something SpellCraft generates (a README.md living beside a
    // generated one) is never SpellCraft's to delete, and silently sweeping by
    // pattern can't tell the two apart.
    //
    // The very first write() against a render/ directory has no manifest to
    // read -- either render/ is new, or it predates this manifest existing at
    // all. Only in that one case, fall back to the old sweep-by-registered-
    // pattern, so upgrading doesn't strand pre-manifest output forever; every
    // clean after that first write is manifest-driven.
    cleanRenderPath() {
        if (!fs.existsSync(this.renderPath)) return;

        if (!fs.existsSync(this.manifestPath)) {
            try {
                Object.keys(this.fileTypeHandlers).forEach(regexPattern => {
                    const regex = new RegExp(regexPattern, "i");
                    fs.readdirSync(this.renderPath)
                        .filter(f => regex.test(f))
                        .forEach(f => this.removeRenderedFile(f));
                });
            } catch (e) {
                console.warn(`  [!] Could not sweep ${this.renderPath}: ${e.message}`);
            }
            return;
        }

        let previous;
        try {
            previous = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
        } catch (e) {
            console.warn(`  [!] Could not read ${this.manifestPath}, leaving ${this.renderPath} untouched: ${e.message}`);
            return;
        }

        if (!Array.isArray(previous)) return;

        previous.forEach(filename => this.removeRenderedFile(filename));
    }

    // Unlike the try{}catch(e){} this replaces, failures and removals are both
    // reported rather than swallowed -- nothing here should be a silent
    // no-op.
    removeRenderedFile(filename) {
        const filePath = path.join(this.renderPath, filename);
        if (!fs.existsSync(filePath)) return;

        try {
            fs.unlinkSync(filePath);
            console.log('  -x ' + filename);
        } catch (e) {
            console.warn(`  [!] Could not remove ${filename}: ${e.message}`);
        }
    }

    write(filesToWrite = this.lastRender) {
        if (!filesToWrite || typeof filesToWrite !== 'object') return this;

        if (!fs.existsSync(this.renderPath)) {
            fs.mkdirSync(this.renderPath, { recursive: true });
        }

        if (this.cleanBeforeRender) {
            this.cleanRenderPath();
        }

        console.log(`[+] Writing files to: ${this.renderPath}`);
        const written = [];
        for (const filename in filesToWrite) {
            if (Object.prototype.hasOwnProperty.call(filesToWrite, filename)) {
                const outputFilePath = path.join(this.renderPath, filename);
                const [, handlerFn] = Object.entries(this.fileTypeHandlers)
                    .find(([pattern]) => new RegExp(pattern).test(filename)) || [null, defaultFileHandler];

                try {
                    fs.writeFileSync(outputFilePath, handlerFn(filesToWrite[filename]), 'utf-8');
                    console.log('  -> ' + path.basename(outputFilePath));
                    written.push(filename);
                } catch (e) {
                    console.error(`  [!] Error writing ${filename}: ${e.message}`);
                }
            }
        }

        // Only what was actually written lands in the manifest -- a file whose
        // write() threw above stays out, so a transient failure this run
        // doesn't get "cleaned" as if it were stale next run.
        fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
        fs.writeFileSync(this.manifestPath, JSON.stringify(written, null, 4), 'utf-8');

        this.emit('write', filesToWrite);
        return this;
    }
};