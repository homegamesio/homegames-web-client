/**
 * Loads a game class from a map of source files, in the browser.
 *
 * Published games are CommonJS modules that may only require their squish
 * version and their own files (the publish sandbox enforces this), so a full
 * module system isn't needed — just a require shim that resolves squish-NNN
 * to the bundled module and relative paths within the provided file map.
 *
 * Usage:
 *   const gameClass = loadGameClass({
 *       files: { 'index.js': '...source...', 'weapons.js': '...', 'minigames/drive.js': '...' },
 *       entryPoint: 'index.js',
 *   });
 */

const { squishMap, DEFAULT_VERSION } = require('./squish-map');
// Shared with the server-side map builders (homegames-core / the API) — the
// builder and this executor must resolve requires identically.
const { normalizePath, resolveInFiles } = require('homegames-common/local-play-shared');

const loadGameClass = ({ files, entryPoint }) => {
    if (!files || !entryPoint) {
        throw new Error('loadGameClass requires { files, entryPoint }');
    }

    // Normalize keys so lookups match regardless of './index.js' vs 'index.js'
    const normalized = {};
    for (const key of Object.keys(files)) {
        normalized[normalizePath(key)] = files[key];
    }

    const moduleCache = {};

    const loadModule = (path) => {
        if (moduleCache[path]) return moduleCache[path].exports;

        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

        const requireShim = (request) => {
            const squishMatch = /^squish-(\d+)$/.exec(request);
            if (squishMatch) {
                const squishModule = squishMap[squishMatch[1]];
                if (squishModule) return squishModule;
                throw new Error('Unsupported Squish runtime: ' + request);
            }

            if (request.startsWith('./') || request.startsWith('../')) {
                const resolved = resolveInFiles(normalized, dir, request);
                if (resolved) return loadModule(resolved);
                throw new Error('Cannot resolve require(\'' + request + '\') from ' + path + ' — not in the game source map');
            }

            throw new Error('Game tried to require(\'' + request + '\') — local games may only require their squish version and their own files');
        };

        const module = { exports: {} };
        moduleCache[path] = module;

        const source = normalized[path];
        if (path.endsWith('.json')) {
            try {
                module.exports = JSON.parse(source);
                return module.exports;
            } catch (err) {
                delete moduleCache[path];
                throw new Error('Invalid JSON module ' + path + ': ' + err.message);
            }
        }
        const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', source);
        try {
            fn(module, module.exports, requireShim, path, dir);
        } catch (err) {
            delete moduleCache[path];
            throw err;
        }

        return module.exports;
    };

    const entry = normalizePath(entryPoint);
    if (!Object.prototype.hasOwnProperty.call(normalized, entry)) {
        throw new Error('Entry point "' + entryPoint + '" not found in game source map');
    }

    return loadModule(entry);
};

module.exports = { loadGameClass };
