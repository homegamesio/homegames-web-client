/**
 * LocalSession — runs a Homegames game entirely in the browser, no server.
 *
 * The game class is instantiated locally, the real squish Squisher drives the
 * tick loop and per-player frame generation (so playerIds visibility, state
 * coalescing, and z-order behave byte-identically to a hosted session), and
 * a LocalDispatcher replicates the server's input semantics. The existing
 * Renderer / AssetManager / InputHandler are reused unchanged — from their
 * point of view this looks like a normal connected session.
 *
 * Single-player by design: one fake local player (default id 1) "joins" at
 * start(). Games that require multiplayer services or homenames identity are
 * not supported here.
 *
 * Usage:
 *   const session = new LocalSession({
 *       containerId: 'game-div',
 *       gameClass: require('some-game'),
 *   });
 *   session.start();
 *
 * The squish->unsquish round trip per frame is intentional scaffolding: it
 * buys exact parity with hosted rendering while local mode stabilizes. A
 * direct tree-walk renderer can replace the frame source later without
 * touching games or the draw code.
 */

const { squishMap, DEFAULT_VERSION } = require('./squish-map');
const AssetManager = require('./assets');
const Renderer = require('./renderer');
const InputHandler = require('./input');
const LocalDispatcher = require('./local-dispatch');
const { loadGameClass } = require('./game-loader');

// Same anonymous-name style the server uses (game-session.js)
const NAME_WORDS = [
    'chocolate', 'iguana', 'cardigan', 'enormous', 'gargantuan', 'orangutan',
    'cookies', 'monstera', 'daisy', 'grapefruit', 'blueberry', 'mango',
    'elephant', 'bamboo', 'sapphire', 'papaya', 'waffle', 'turquoise',
    'aquatic', 'goblin', 'funky', 'hotdog', 'elegant', 'cascade', 'euphoria',
];
const generateName = () => {
    const pick = () => NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)];
    return pick() + ' ' + pick();
};

class LocalSession {
    /**
     * @param {object} opts
     * @param {string} opts.containerId — ID of the DOM element to render into
     * @param {function} [opts.gameClass] — the game class (extends squish Game)
     * @param {object} [opts.files] — alternative to gameClass: map of
     *        {relativePath: sourceCode} for the game's files (e.g. fetched
     *        from the platform API), loaded via the require shim
     * @param {string} [opts.entryPoint] — entry path within files (default 'index.js')
     * @param {number} [opts.playerId] — local player id (default 1)
     * @param {string} [opts.playerName] — local player name (default: generated)
     * @param {Uint8Array|Uint8ClampedArray} [opts.assetBundle] — pre-built
     *        type-1 asset bundle bytes (e.g. built by the API). Local sessions
     *        cannot fetch asset data themselves.
     * @param {function} [opts.onReady] — callback(playerId) when running
     * @param {function} [opts.onError] — callback(error)
     */
    constructor(opts) {
        this.containerId = opts.containerId;
        this.gameClass = opts.gameClass || null;
        this.files = opts.files || null;
        this.entryPoint = opts.entryPoint || 'index.js';
        this.playerId = opts.playerId || 1;
        this.playerName = opts.playerName || generateName();
        this.assetBundle = opts.assetBundle || null;
        this.onReady = opts.onReady || (() => {});
        this.onError = opts.onError || (() => {});

        this.game = null;
        this.squisher = null;
        this.dispatcher = null;
        this.canvas = null;
        this.container = null;
        this.assetManager = null;
        this.renderer = null;
        this.inputHandler = null;
        this.unsquish = null;
        this.aspectRatio = null;

        this.currentBuf = null;
        this.rendering = false;
        this._frameDirty = false;
        this._rafId = null;
        this._resizeHandler = null;
    }

    start() {
        // --- Set up DOM ---
        this.container = document.getElementById(this.containerId);
        if (!this.container) {
            this.onError(new Error('Container element not found: #' + this.containerId));
            return;
        }

        this.container.innerHTML = '';
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.background = '#000';

        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.margin = '0 auto';
        this.container.appendChild(this.canvas);

        // --- Load game class from source map if not passed directly ---
        if (!this.gameClass && this.files) {
            try {
                this.gameClass = loadGameClass({ files: this.files, entryPoint: this.entryPoint });
            } catch (err) {
                this.onError(err);
                return;
            }
        }
        if (!this.gameClass) {
            this.onError(new Error('LocalSession needs either gameClass or files'));
            return;
        }

        // --- Resolve squish version from game metadata ---
        const metadata = (typeof this.gameClass.metadata === 'function') ? this.gameClass.metadata() : {};
        const squishVersion = metadata.squishVersion || DEFAULT_VERSION;
        let squishModule = squishMap[squishVersion];
        if (!squishModule) {
            console.warn('Unknown squish version: ' + squishVersion + ', falling back to ' + DEFAULT_VERSION);
            squishModule = squishMap[DEFAULT_VERSION];
        }
        this.unsquish = squishModule.unsquish;
        this.aspectRatio = metadata.aspectRatio || { x: 16, y: 9 };

        // --- Instantiate game + squisher ---
        try {
            // Same option bag child_game_server passes; persistence and
            // platform services are stubbed in local mode. addAsset is real:
            // player uploads must render locally just like in a hosted session.
            this.game = new this.gameClass({
                addAsset: (key, asset) => this._addLocalAsset(key, asset),
                saveGame: () => Promise.resolve(),
                saveData: null,
                services: {},
            });
            // The Squisher starts the game's tick loop and registers itself as
            // a state listener on every node — identical to a hosted session.
            // Frameless: no custom layers, scale 1.
            this.squisher = new squishModule.Squisher({ game: this.game });
        } catch (err) {
            this.onError(err);
            return;
        }

        this.dispatcher = new LocalDispatcher(this.game, this.playerId);

        // --- Set up subsystems (identical wiring to HomegamesClient, with
        // the dispatcher standing in for the socket send function) ---
        this.assetManager = new AssetManager();
        this.assetManager.onAssetReady = () => { this._frameDirty = true; };
        this.renderer = new Renderer(this.canvas, this.assetManager);
        this.inputHandler = new InputHandler(
            this.canvas,
            (msg) => this.dispatcher.handleMessage(msg),
            () => this.renderer.thingIndices,
            this.assetManager
        );
        this.inputHandler.attach();

        this._resizeHandler = () => this._initCanvas();
        window.addEventListener('resize', this._resizeHandler);
        this._initCanvas();

        if (this.assetBundle) {
            this.assetManager.storeAssets(this.assetBundle);
        }

        // --- State changes -> new local frame ---
        // The squisher coalesces node mutations and fires listeners once per
        // flush, so this is already one capture per burst.
        this.squisher.addListener(() => this._captureFrame());

        // --- Fake local player joins (same payload shape the server builds) ---
        const playerPayload = {
            playerId: this.playerId,
            settings: { SOUND: true },
            info: { name: this.playerName },
            clientInfo: this._getClientInfo(),
            requestedGame: null,
        };
        try {
            this.game.handleNewPlayer && this.game.handleNewPlayer(playerPayload);
        } catch (e) {
            console.error('[LocalSession] game.handleNewPlayer threw:', e);
        }

        this._captureFrame();
        this.rendering = true;
        this._renderLoop();
        this.onReady(this.playerId);
    }

    stop() {
        this.rendering = false;

        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        if (this.game) {
            try { this.game.handlePlayerDisconnect && this.game.handlePlayerDisconnect(this.playerId); } catch (e) {}
            try { this.game.close && this.game.close(); } catch (e) {}
            try { this.game.destroy && this.game.destroy(); } catch (e) {}
            this.game = null;
        }

        // End the Squisher's tick loop so repeated start/stop cycles — e.g.
        // Studio hot reload — don't accumulate running tick intervals driving
        // dead games.
        if (this.squisher && this.squisher._tickInterval) {
            clearInterval(this.squisher._tickInterval);
        }
        this.squisher = null;

        if (this.inputHandler) {
            this.inputHandler.detach();
            this.inputHandler = null;
        }

        if (this.renderer) {
            this.renderer.stopAllSounds();
            this.renderer = null;
        }

        if (this.assetManager) {
            this.assetManager.destroy();
            this.assetManager = null;
        }

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }

        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    // --- Private ---

    // Local counterpart of GameSession.handleNewAsset: a hosted session
    // rebuilds the asset bundle and pushes it to every client; locally the
    // one client is us, so store the bytes straight into the AssetManager.
    // Only in-memory asset data is supported — local sessions can't fetch
    // from the asset store (same constraint as the assetBundle option).
    _addLocalAsset(key, asset) {
        try {
            const type = (asset && asset.info && asset.info.type) || 'image';
            const data = asset && asset.data;
            if (data && this.assetManager) {
                this.assetManager.storeRawAsset(key, type, data);
                this._frameDirty = true;
            }
        } catch (err) {
            console.error('[LocalSession] addAsset failed:', err);
        }
        return Promise.resolve();
    }

    // Mirrors GameSession._sendPlayerFrame: flush pending changes, take the
    // player-scoped frame, fall back to the broadcast state when the player
    // has no scoped nodes anywhere in the tree.
    _captureFrame() {
        if (!this.squisher) return;
        if (typeof this.squisher.flush === 'function') this.squisher.flush();
        let frame = this.squisher.getPlayerFrame(this.playerId);
        if (!frame) frame = this.squisher.state;
        if (!frame || !frame.length) return;
        const flat = Array.isArray(frame) ? frame.flat() : frame;
        // Buffer.from is load-bearing, not just a container: squish's scaled
        // coordinate path emits raw floats for the integer byte and relies on
        // the wire's Buffer truncation to floor them. Uint8ClampedArray ROUNDS
        // instead, shifting any vertex with fractional part >= .5 by a full
        // plane unit (visible as polygon wobble). Truncate exactly like the
        // server's ws send path does.
        this.currentBuf = new Uint8ClampedArray(Buffer.from(flat));
        this._frameDirty = true;
    }

    _initCanvas() {
        if (!this.aspectRatio || !this.container) return;

        const maxWidth = this.container.clientWidth || window.innerWidth;
        const maxHeight = this.container.clientHeight || window.innerHeight;

        const canFitHeight = (maxWidth * this.aspectRatio.y / this.aspectRatio.x) <= maxHeight;

        let canvasWidth, canvasHeight;

        if (canFitHeight) {
            canvasWidth = maxWidth;
            canvasHeight = Math.floor(maxWidth * (this.aspectRatio.y / this.aspectRatio.x));
        } else {
            canvasHeight = maxHeight;
            canvasWidth = Math.floor(maxHeight * (this.aspectRatio.x / this.aspectRatio.y));
        }

        // Use 2x resolution for crisp rendering
        this.canvas.width = 2 * canvasWidth;
        this.canvas.height = 2 * canvasHeight;
        this.canvas.style.width = canvasWidth + 'px';
        this.canvas.style.height = canvasHeight + 'px';

        if (this.inputHandler) {
            this.inputHandler.clientWidth = canvasWidth;
            this.inputHandler.clientHeight = canvasHeight;
        }

        // Resizing clears the canvas, so the current frame must be repainted.
        this._frameDirty = true;
    }

    _renderLoop() {
        if (!this.rendering) return;

        if (this.inputHandler) {
            this.inputHandler.tick();
        }

        if (this._frameDirty && this.currentBuf && this.currentBuf.length > 1 && this.currentBuf[0] === 3 && this.unsquish) {
            this.renderer.renderFrame(this.currentBuf, this.unsquish);
            this._frameDirty = false;
        }

        this._rafId = requestAnimationFrame(() => this._renderLoop());
    }

    _getClientInfo() {
        const ua = navigator.userAgent;
        const info = {};

        if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
            info.deviceType = 'tablet';
        } else if (/Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
            info.deviceType = 'mobile';
        } else if (navigator.maxTouchPoints && navigator.maxTouchPoints > 2) {
            info.deviceType = 'tablet';
        } else {
            info.deviceType = 'desktop';
        }

        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w && h) info.aspectRatio = w / h;

        return info;
    }
}

module.exports = LocalSession;
