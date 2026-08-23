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
const {
    createSaveStore,
    createDebouncedWriter,
    serializeSaveData,
    isCompatibleSave,
    DEFAULT_VERSION_ID,
} = require('./save-store');

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
     * @param {string} [opts.gameKey] — stable key for save-game storage
     *        (default: the game class's name)
     * @param {function} [opts.onSaveData] — callback(envelope) after a save
     *        is persisted locally
     * @param {object} [opts.saveStore] — injectable save store (testing)
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
        this.gameKey = opts.gameKey || null;
        this.onSaveData = opts.onSaveData || null;
        this.saveStore = opts.saveStore || createSaveStore();

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
        this.frozen = false;     // game ended, view kept for inspection
        this._frameDirty = false;
        this._rafId = null;
        this._resizeHandler = null;

        // Inspector state (see the Inspector API section below)
        this._inspector = null;          // onSnapshot callback while enabled
        this._onInput = null;            // input-event callback while enabled
        this._inspectBuf = null;         // recorded frame pinned to the canvas
        this._inputDetached = false;     // game input suspended (inspect/pick)
        this._highlight = null;          // halo polygon, 0-100 coordinate space
        this._pick = null;               // pick-mode callbacks while active

        // Extra simulated players (addPlayer): each renders its own
        // player-scoped frame into its own canvas with its own input pipeline.
        this.extraPlayers = [];
    }

    start() {
        // Guards the async save-load gap below: a stop() (or a second start())
        // during the load must prevent the stale boot from running.
        this._bootGeneration = (this._bootGeneration || 0) + 1;

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
        this.squishVersion = squishVersion;
        this.aspectRatio = metadata.aspectRatio || { x: 16, y: 9 };

        // --- Save games: browser-backed saveGame/saveData ---
        // saveData is injected at construction (same contract as a hosted
        // session), so the stored save must be loaded before the game exists.
        const gameKey = this.gameKey || this.gameClass.name || 'local-game';
        const saveKey = 'local:' + gameKey;
        const compatibility = Array.isArray(metadata.saveCompatibility) ? metadata.saveCompatibility : [];

        const bootGeneration = this._bootGeneration;
        this.saveStore.getSave(saveKey).catch(() => null).then((envelope) => {
            if (bootGeneration !== this._bootGeneration) return; // stopped/restarted mid-load
            const saveData = (envelope && isCompatibleSave(envelope, DEFAULT_VERSION_ID, compatibility))
                ? envelope.data
                : undefined;

            // Debounced like the server backends: bursts coalesce, last write
            // wins, callers resolve when the batched write lands.
            const writeSave = createDebouncedWriter({
                intervalMs: 1000,
                write: (env) => this.saveStore.putSave(saveKey, env).then(() => {
                    if (this.onSaveData) {
                        try { this.onSaveData(env); } catch (e) {}
                    }
                }),
            });
            const saveGame = (data) => {
                let cleaned;
                try {
                    cleaned = JSON.parse(serializeSaveData(data));
                } catch (err) {
                    return Promise.reject(err);
                }
                return writeSave({ gameKey, versionId: DEFAULT_VERSION_ID, savedAt: Date.now(), data: cleaned });
            };

            this._boot({ squishModule, saveGame, saveData });
        });
    }

    // Second half of start(): runs once the stored save (if any) has loaded,
    // because the game constructor takes saveData directly.
    _boot({ squishModule, saveGame, saveData }) {
        // --- Instantiate game + squisher ---
        try {
            // Same option bag child_game_server passes; platform services are
            // stubbed in local mode. addAsset and saveGame/saveData are real:
            // uploads render locally and saves persist in browser storage.
            this.game = new this.gameClass({
                addAsset: (key, asset) => this._addLocalAsset(key, asset),
                saveGame,
                saveData,
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
            (msg) => {
                this._noteInput(msg);
                this.dispatcher.handleMessage(msg);
            },
            () => this.renderer.thingIndices,
            this.assetManager
        );
        this.inputHandler.squishVersion = this.squishVersion;
        this.inputHandler.attach();

        this._resizeHandler = () => this._initCanvas();
        window.addEventListener('resize', this._resizeHandler);
        this._initCanvas();

        if (this.assetBundle) {
            this.assetManager.storeAssets(this.assetBundle);
        }

        // --- State changes -> new local frame ---
        // The squisher coalesces node mutations and fires listeners once per
        // flush, so this is already one capture per burst. Tree changes can
        // remove a node mid-drag, so close out any orphaned press first
        // (safe here: ending a press deletes it before offClick fires, so a
        // re-entrant flush from offClick's own mutations no-ops).
        this.squisher.addListener(() => {
            if (this.dispatcher) this.dispatcher.checkActivePresses();
            this.extraPlayers.forEach(p => p.dispatcher.checkActivePresses());
            this._captureFrame();
        });

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

    // --- Inspector API ---
    // Debug hooks for the Studio tree inspector. While enabled, every squisher
    // flush also emits { time, buf, tree } to the callback: buf is the squished
    // frame (renderable later via showFrame), tree is a JSON-safe walk of the
    // game's layers at that moment.

    enableInspector(onSnapshot, onInput) {
        this._inspector = onSnapshot;
        this._onInput = onInput || null;
        this._emitSnapshot();
    }

    disableInspector() {
        this._inspector = null;
        this._onInput = null;
        this.disablePick();
        this.setHighlight(null);
        this.resumeLive();
    }

    // Pin a recorded frame to the canvas. Live frames keep being captured (and
    // emitted to the inspector) but stop being painted, and game input is
    // detached — clicks against an old frame would hit nodes that no longer
    // exist.
    showFrame(buf) {
        if (!this.renderer || !this.unsquish || !buf) return;
        this._inspectBuf = buf;
        this._updateInputAttachment();
        this._paintInspectedFrame();
    }

    resumeLive() {
        this._inspectBuf = null;
        this._updateInputAttachment();
        this._frameDirty = true;
    }

    // Pick mode: the pointer roams the primary canvas reporting 0-100 coords
    // (onMove(x, y), null on leave) and a click resolves to onPick(x, y),
    // ending pick mode. Game input is suspended for the duration — hit
    // testing and node selection are the caller's job (it has the inspector's
    // tree snapshots).
    enablePick({ onMove, onPick } = {}) {
        if (!this.canvas) return;
        this.disablePick();
        const toCoords = (e) => {
            const r = this.canvas.getBoundingClientRect();
            return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100];
        };
        this._pick = {
            move: (e) => {
                if (onMove) onMove(...toCoords(e));
            },
            click: (e) => {
                const [x, y] = toCoords(e);
                this.disablePick();
                if (onPick) onPick(x, y);
            },
            leave: () => {
                if (onMove) onMove(null, null);
            },
        };
        this.canvas.addEventListener('mousemove', this._pick.move);
        this.canvas.addEventListener('click', this._pick.click);
        this.canvas.addEventListener('mouseleave', this._pick.leave);
        this.canvas.style.cursor = 'crosshair';
        this._updateInputAttachment();
    }

    disablePick() {
        if (!this._pick || !this.canvas) { this._pick = null; return; }
        this.canvas.removeEventListener('mousemove', this._pick.move);
        this.canvas.removeEventListener('click', this._pick.click);
        this.canvas.removeEventListener('mouseleave', this._pick.leave);
        this.canvas.style.cursor = '';
        this._pick = null;
        this._updateInputAttachment();
    }

    // The primary player's game input is suspended while a recorded frame is
    // pinned or pick mode is active. Extra players are unaffected.
    _updateInputAttachment() {
        if (!this.inputHandler) return;
        const shouldDetach = !!this._inspectBuf || !!this._pick;
        if (shouldDetach && !this._inputDetached) {
            this.inputHandler.detach();
            this._inputDetached = true;
        } else if (!shouldDetach && this._inputDetached) {
            this.inputHandler.attach();
            this._inputDetached = false;
        }
    }

    // Inspector timeline: note primary-player inputs as they head into the
    // dispatcher. Drag-spam (mousemove) is skipped.
    _noteInput(msg) {
        if (!this._onInput) return;
        try {
            const input = JSON.parse(msg);
            if (!input || typeof input.type !== 'string') return;
            if (input.type === 'mousemove' || input.type === 'onhover' || input.type === 'offhover') return;
            const evt = { time: performance.now(), type: input.type };
            if (typeof input.key === 'string') evt.key = input.key;
            this._onInput(evt);
        } catch (e) {}
    }

    // Halo a node in the game view. points: array of [x, y] pairs in the 0-100
    // coordinate space (a node's coordinates2d, or a rect built from an asset
    // or text position). null clears the halo.
    setHighlight(points) {
        this._highlight = (points && points.length) ? points : null;
        if (this._inspectBuf) this._paintInspectedFrame();
        else this._frameDirty = true;
    }

    _paintInspectedFrame() {
        if (!this._inspectBuf || !this.renderer) return;
        this.renderer.renderFrame(this._inspectBuf, this.unsquish, { muteAudio: true });
        this._drawHighlight();
    }

    _drawHighlight() {
        if (!this._highlight || !this.canvas) return;
        const ctx = this.canvas.getContext('2d');
        const { width, height } = this.canvas;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(this._highlight[0][0] * width / 100, this._highlight[0][1] * height / 100);
        for (let i = 1; i < this._highlight.length; i++) {
            ctx.lineTo(this._highlight[i][0] * width / 100, this._highlight[i][1] * height / 100);
        }
        ctx.closePath();
        ctx.shadowColor = 'rgba(148, 210, 229, 0.9)';
        ctx.shadowBlur = Math.max(12, width * 0.012);
        ctx.strokeStyle = 'rgba(148, 210, 229, 0.95)';
        ctx.lineWidth = Math.max(2, width * 0.003);
        // Stroke twice — the second pass compounds the glow into a visible halo
        ctx.stroke();
        ctx.stroke();
        ctx.restore();
    }

    _emitSnapshot() {
        if (!this._inspector || !this.currentBuf) return;
        let tree = null;
        try {
            tree = (this.game.getLayers() || []).map(layer => this._serializeNode(layer.root));
        } catch (e) {
            // A mid-mutation tree walk can throw; the frame buffer is still useful
        }
        try {
            this._inspector({ time: performance.now(), buf: this.currentBuf, tree });
        } catch (e) {
            console.error('[LocalSession] inspector callback threw:', e);
        }
    }

    // --- Extra simulated players ---

    // Join a second (third, ...) local player rendering into containerId.
    // Shares the game, squisher, and asset store; gets its own canvas,
    // renderer, dispatcher, and input pipeline, so player-scoped nodes and
    // per-player interaction behave like a real multi-device session. Audio
    // stays with the primary player — two renderers would double-play every
    // sound. Returns the new playerId, or null.
    addPlayer(containerId) {
        if (!this.game || !this.squisher) return null;
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('[LocalSession] addPlayer: container not found: #' + containerId);
            return null;
        }

        const used = [this.playerId, ...this.extraPlayers.map(p => p.playerId)];
        const playerId = Math.max(...used) + 1;

        container.innerHTML = '';
        container.style.position = 'relative';
        container.style.overflow = 'hidden';
        container.style.background = '#000';
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto';
        container.appendChild(canvas);

        const renderer = new Renderer(canvas, this.assetManager);
        const dispatcher = new LocalDispatcher(this.game, playerId);
        const inputHandler = new InputHandler(
            canvas,
            (msg) => dispatcher.handleMessage(msg),
            () => renderer.thingIndices,
            this.assetManager
        );
        inputHandler.squishVersion = this.squishVersion;
        inputHandler.attach();

        const player = {
            playerId,
            container,
            canvas,
            renderer,
            dispatcher,
            inputHandler,
            playerName: generateName(),
            currentBuf: null,
            frameDirty: false,
        };
        this.extraPlayers.push(player);
        this._sizeCanvas(player);

        try {
            this.game.handleNewPlayer && this.game.handleNewPlayer({
                playerId,
                settings: { SOUND: true },
                info: { name: player.playerName },
                clientInfo: this._getClientInfo(),
                requestedGame: null,
            });
        } catch (e) {
            console.error('[LocalSession] game.handleNewPlayer threw for extra player:', e);
        }

        this._captureFrame();
        return playerId;
    }

    removePlayer(playerId) {
        const idx = this.extraPlayers.findIndex(p => p.playerId === playerId);
        if (idx === -1) return;
        const player = this.extraPlayers.splice(idx, 1)[0];
        try {
            this.game && this.game.handlePlayerDisconnect && this.game.handlePlayerDisconnect(playerId);
        } catch (e) {}
        player.inputHandler.detach();
        player.renderer.stopAllSounds();
        player.container.innerHTML = '';
    }

    // JSON-safe copy of a GameNode subtree — enough to render a tree view and
    // compute highlight bounds, nothing live-referenced.
    _serializeNode(gameNode) {
        const n = gameNode.node;
        const out = { id: n.id };
        if (n.subType) out.subType = n.subType;
        if (n.coordinates2d && n.coordinates2d.length) {
            out.coordinates2d = Array.from(n.coordinates2d, (pt) => [pt[0], pt[1]]);
        }
        if (n.fill) out.fill = Array.from(n.fill);
        if (n.color) out.color = Array.from(n.color);
        if (n.border !== null && n.border !== undefined) out.border = n.border;
        if (n.text) {
            out.text = {
                text: n.text.text, x: n.text.x, y: n.text.y,
                size: n.text.size, align: n.text.align,
            };
        }
        if (n.asset) {
            const key = Object.keys(n.asset)[0];
            const a = n.asset[key] || {};
            out.asset = { key };
            if (a.pos) out.asset.pos = { x: a.pos.x, y: a.pos.y };
            if (a.size) out.asset.size = { x: a.size.x, y: a.size.y };
        }
        if (n.playerIds && n.playerIds.length) out.playerIds = n.playerIds.slice();
        if (n.handleClick) out.clickable = true;
        if (n.input && n.input.type) out.input = n.input.type;
        out.children = n.children.map(c => this._serializeNode(c));
        return out;
    }

    // End the game — tick loop, players, input — but keep the view alive:
    // canvas, renderer, assets, and the render loop stay up, so the inspector
    // can keep painting recorded frames, halos, and pick against snapshots
    // after the simulation is gone. A later stop() (or start of a new session)
    // still tears everything down.
    freeze() {
        if (this.frozen) return;
        this.frozen = true;

        if (this.game) {
            this.extraPlayers.forEach(player => {
                try { this.game.handlePlayerDisconnect && this.game.handlePlayerDisconnect(player.playerId); } catch (e) {}
            });
            try { this.game.handlePlayerDisconnect && this.game.handlePlayerDisconnect(this.playerId); } catch (e) {}
            try { this.game.close && this.game.close(); } catch (e) {}
            try { this.game.destroy && this.game.destroy(); } catch (e) {}
            this.game = null;
        }

        if (this.squisher && this.squisher._tickInterval) {
            clearInterval(this.squisher._tickInterval);
        }
        this.squisher = null;

        if (this.inputHandler) {
            this.inputHandler.detach();
            this.inputHandler = null;
        }
        this.dispatcher = null;
        this.extraPlayers.forEach(player => {
            player.inputHandler.detach();
            player.renderer.stopAllSounds();
        });

        if (this.renderer) this.renderer.stopAllSounds();
    }

    stop() {
        this._bootGeneration = (this._bootGeneration || 0) + 1; // cancel a pending _boot
        this.rendering = false;
        this.frozen = false;
        this.disablePick();
        this._inspector = null;
        this._onInput = null;
        this._inspectBuf = null;
        this._inputDetached = false;
        this._highlight = null;

        this.extraPlayers.forEach(player => {
            try { this.game && this.game.handlePlayerDisconnect && this.game.handlePlayerDisconnect(player.playerId); } catch (e) {}
            player.inputHandler.detach();
            player.renderer.stopAllSounds();
            player.container.innerHTML = '';
        });
        this.extraPlayers = [];

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

        this.extraPlayers.forEach(player => {
            let pFrame = this.squisher.getPlayerFrame(player.playerId);
            if (!pFrame) pFrame = this.squisher.state;
            if (!pFrame || !pFrame.length) return;
            const pFlat = Array.isArray(pFrame) ? pFrame.flat() : pFrame;
            player.currentBuf = new Uint8ClampedArray(Buffer.from(pFlat));
            player.frameDirty = true;
        });

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
        this._emitSnapshot();
    }

    _initCanvas() {
        if (!this.aspectRatio || !this.container) return;
        this._sizeCanvas({ canvas: this.canvas, container: this.container, inputHandler: this.inputHandler });
        this.extraPlayers.forEach(player => {
            this._sizeCanvas(player);
            player.frameDirty = true;
        });

        // Resizing clears the canvas, so the current frame must be repainted.
        this._frameDirty = true;
        if (this._inspectBuf) this._paintInspectedFrame();
    }

    // Fit a canvas to its container at the game's aspect ratio (any player's
    // view — primary or extra).
    _sizeCanvas({ canvas, container, inputHandler }) {
        if (!this.aspectRatio || !canvas || !container) return;

        const maxWidth = container.clientWidth || window.innerWidth;
        const maxHeight = container.clientHeight || window.innerHeight;

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
        canvas.width = 2 * canvasWidth;
        canvas.height = 2 * canvasHeight;
        canvas.style.width = canvasWidth + 'px';
        canvas.style.height = canvasHeight + 'px';

        if (inputHandler) {
            inputHandler.clientWidth = canvasWidth;
            inputHandler.clientHeight = canvasHeight;
        }
    }

    _renderLoop() {
        if (!this.rendering) return;

        if (this.inputHandler) {
            this.inputHandler.tick();
        }

        // While the inspector has a recorded frame pinned, live frames keep
        // being captured but not painted; the dirty flag is dropped because
        // resumeLive() re-marks it.
        if (this._frameDirty && this.currentBuf && this.currentBuf.length > 1 && this.currentBuf[0] === 3 && this.unsquish) {
            if (!this._inspectBuf) {
                this.renderer.renderFrame(this.currentBuf, this.unsquish);
                this._drawHighlight();
            }
            this._frameDirty = false;
        }

        this.extraPlayers.forEach(player => {
            player.inputHandler.tick();
            if (player.frameDirty && player.currentBuf && player.currentBuf.length > 1 && player.currentBuf[0] === 3) {
                // Audio belongs to the primary view — see addPlayer
                player.renderer.renderFrame(player.currentBuf, this.unsquish, { muteAudio: true });
                player.frameDirty = false;
            }
        });

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
