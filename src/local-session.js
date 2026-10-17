const { ProjectTransferHost } = require('homegames-common/project-transfer');
const createLocalRuntime = require('./local-game-runtime');
const { playerFrame } = require('homegames-common/session-runtime');
const { packAssetBundle } = require('./asset-bundle');
const { splitAssetBundle } = require('homegames-common/local-play-shared');
const { createFileUploadHandler } = require('homegames-common/media-upload');
const { normalizeCursor, encodeCursor } = require('homegames-common/cursor');
const MediaSession = require('homegames-common/media-session');
const MediaClient = require('./media-client');
const { GameView, FrameLoop, getClientInfo } = require('./game-view');
/**
 * LocalSession — runs a Homegames game entirely in the browser, no server.
 *
 * The game class is instantiated locally, LocalRuntime owns its tick clock,
 * and the real Squish Squisher generates per-player frames. LocalDispatcher
 * and the server use the same GameDispatcher for game-facing input. The existing
 * Renderer / AssetManager / InputHandler are reused unchanged — from their
 * point of view this looks like a normal connected session.
 *
 * One simulated player (default id 1) joins at start(); addPlayer() creates
 * extra views of the same game for Studio testing. addRemotePlayer() attaches
 * a transport-backed seat to that same runtime, without Homenames identity.
 * Games requiring server-only services cannot run here.
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
const LocalDispatcher = require('./local-dispatch');
const { loadGameClass } = require('./game-loader');
const {
    createSaveStore,
    createDebouncedWriter,
    serializeSaveData,
    isCompatibleSave,
    DEFAULT_VERSION_ID,
} = require('./save-store');

const { generateName, initialName, normalizeName } = require('homegames-common/player-identity');

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
     * @param {string} [opts.versionId] — version for save compatibility checks
     *        (default: local-game-version for unversioned games)
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
        this.gamepadOptions = opts.gamepad ?? {};
        this.platform = opts.platform;
        this.packageRevision = opts.packageRevision;
        this.containerId = opts.containerId;
        this.gameClass = opts.gameClass || null;
        this.files = opts.files || null;
        this.entryPoint = opts.entryPoint || 'index.js';
        this.playerId = opts.playerId || 1;
        this.playerName = initialName(opts.playerName);
        this.assetBundle = opts.assetBundle || null;
        this.assetPackets = this.assetBundle ? splitAssetBundle(this.assetBundle) : [];
        this.onReady = opts.onReady || (() => {});
        this.onError = opts.onError || (() => {});
        this.gameKey = opts.gameKey || null;
        this.versionId = opts.versionId || DEFAULT_VERSION_ID;
        this.onSaveData = opts.onSaveData || null;
        this.saveStore = opts.saveStore || createSaveStore();

        this.game = null;
        this.runtime = null;
        this.players = []; // primary first; every seat has the same view/dispatch/frame record
        this.dynamicAssets = new Map();
        this.onStop = null;
        this.unsquish = null;
        this.aspectRatio = null;
        this.pointerLockEnabled = false;

        this.frozen = false;     // game ended, view kept for inspection
        this._loop = new FrameLoop(() => this._paintFrame());
        this._resizeHandler = null;

        // Inspector state (see the Inspector API section below)
        this._inspector = null;          // onSnapshot callback while enabled
        this._onInput = null;            // input-event callback while enabled
        this._inspectBuf = null;         // recorded frame pinned to the canvas
        this._highlight = null;          // halo polygon, 0-100 coordinate space
        this._pick = null;               // pick-mode callbacks while active
    }

    // Primary-view accessors retain the existing embedding interface without
    // storing a second copy of resources owned by the view/runtime.
    get _primary() { return this.players[0]; }
    get extraPlayers() { return this.players.slice(1); }
    get view() { return this._primary?.view || null; }
    get container() { return this.view?.container || null; }
    get canvas() { return this.view?.canvas || null; }
    get renderer() { return this.view?.renderer || null; }
    get assetManager() { return this.view?.assetManager || null; }
    get inputHandler() { return this.game ? this.view?.inputHandler || null : null; }
    get dispatcher() { return this._primary?.dispatcher || null; }
    get currentBuf() { return this._primary?.currentBuf || null; }
    get squisher() { return this.runtime?.squisher || null; }
    get rendering() { return this._loop.running; }

    start() {
        this.stop(); // replace any prior runtime/view before starting again
        // --- Set up DOM ---
        const container = document.getElementById(this.containerId);
        if (!container) {
            this.onError(new Error('Container element not found: #' + this.containerId));
            return;
        }

        container.innerHTML = '';

        // --- Load game class from source map if not passed directly ---
        if (!this.gameClass && this.files) {
            try {
                this.gameClass = loadGameClass({ files: this.files, entryPoint: this.entryPoint });
            } catch (err) {
                this.stop();
                this.onError(err);
                return;
            }
        }
        if (!this.gameClass) {
            this.stop();
            this.onError(new Error('LocalSession needs either gameClass or files'));
            return;
        }

        // Loaders bind the statically resolved runtime; legacy class-only embeds
        // retain their metadata/default compatibility path.
        let metadata;
        try { metadata = require('homegames-common/runtime-metadata').runtimeMetadata(this.gameClass); }
        catch (error) { this.stop(); this.onError(error); return; }
        this.maxPlayers = metadata.maxPlayers;
        this.pointerLockEnabled = metadata.pointerLock === true;
        const squishVersion = metadata.squishVersion || DEFAULT_VERSION;
        let squishModule = squishMap[squishVersion];
        if (!squishModule) {
            this.onError(new Error('Unsupported Squish runtime: squish-' + squishVersion));
            return;
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
        // this.saveStore.getSave(saveKey).catch(() => null).then((envelope) => {
        this.exportStorage = this.platform?.getExports ? this.platform : require('homegames-common/export-storage').createExportStorage(window, { installationId: gameKey, gameId: gameKey, packageRevision: this.packageRevision });
        this.saveStore.getSave(saveKey).catch(error => {
            if (this.saveStore.strict) throw error;
            return null;
        }).then(async (envelope) => {
            if (bootGeneration !== this._bootGeneration) return; // stopped/restarted mid-load
            const saveData = (envelope && isCompatibleSave(envelope, this.versionId, compatibility))
                ? envelope.data
                : undefined;

            // Debounced like the server backends: bursts coalesce, last write
            // wins, callers resolve when the batched write lands.
            /* Previous iframe-side debounce retained for rollback.
            const writeSave = createDebouncedWriter({
                intervalMs: 1000,
                write: (env) => this.saveStore.putSave(saveKey, env).then(() => {
                    if (this.onSaveData) {
                        try { this.onSaveData(env); } catch (e) {}
                    }
                }),
            });
            */
            const persist = env => this.saveStore.putSave(saveKey, env).then(() => {
                if (this.onSaveData) {
                    try { this.onSaveData(env); } catch (_) {}
                }
            });
            // A scoped portable store sends immediately to its parent. Other
            // backends retain the existing one-second coalescing behavior.
            const writeSave = this.saveStore.eager ? persist : createDebouncedWriter({intervalMs:1000,write:persist});
            const saveGame = (data) => {
                let cleaned;
                try {
                    cleaned = JSON.parse(serializeSaveData(data));
                } catch (err) {
                    return Promise.reject(err);
                }
                return writeSave({ gameKey, versionId: this.versionId, savedAt: Date.now(), data: cleaned });
            };

            const savedExports = await this.exportStorage.getExports().catch(error => { this.exportStorageError = error; return {}; });
            if (bootGeneration !== this._bootGeneration) return;
            this.userExportsStore = require('homegames-common/game-project').openGameExports(this.gameClass, { saved: savedExports, persist: (name, bytes) => { if (this.exportStorageError) return Promise.reject(this.exportStorageError); return this.exportStorage.putExport(name, bytes); } });
            this._boot({ container, squishModule, saveGame, saveData });
        }).catch(error => { if (bootGeneration === this._bootGeneration) this.onError(error); });
    }

    // Second half of start(): runs once the stored save (if any) has loaded,
    // because the game constructor takes saveData directly.
    _boot({ container, squishModule, saveGame, saveData }) {
        const bootGeneration = this._bootGeneration;
        this.media = new MediaSession();
        const handleFileUpload = createFileUploadHandler({
            Asset: squishModule.Asset,
            registerAsset: (key, asset) => this._addLocalAsset(key, asset),
            isPlayerActive: id => !!this.game && !this.frozen && this.players.some(player => player.playerId === id),
        });
        // --- Instantiate game + squisher ---
        try {
            // Same option bag child_game_server passes. addAsset and saveGame/saveData are real:
            // uploads render locally and saves persist in browser storage.
            this.game = new this.gameClass({
                createExport: this.userExportsStore.createExport,
                userExports: this.userExportsStore.userExports,
                media: this.media,
                addAsset: (key, asset) => this._addLocalAsset(key, asset),
                handleFileUpload,
                setCursor: (playerId, cursor) => bootGeneration === this._bootGeneration
                    && this.setCursor(playerId, cursor),
                saveGame,
                saveData,
            });
            // The runtime owns ticking; Squish owns scene serialization.
            // Frameless: no custom layers, scale 1.
            this.runtime = createLocalRuntime(squishModule, this.game, { userExportsStore: this.userExportsStore });
            this.projectTransfers = new ProjectTransferHost({ exportProject: id => this.exportProject(id),
                listExports: () => this.runtime.listExports(), readExport: (_, name) => this.runtime.readExport(name) });
            for (const [key, asset] of Object.entries(this.game.getAssets?.() || {})) this._addLocalAsset(key, asset);
        } catch (err) {
            this.stop();
            this.onError(err);
            return;
        }

        const runtime = this.runtime;
        this.squisher.addListener(() => {
            if (this.runtime !== runtime) return; // ignore a queued flush from an ended game
            this.players.forEach(player => player.dispatcher?.checkActivePresses());
            this._captureFrame();
        });
        this._joinPlayer(container, this.playerId, this.playerName, this.gamepadOptions);
        if (this.assetBundle) this.assetManager.storeAssets(this.assetBundle);
        for (const asset of this.dynamicAssets.values()) this.assetManager.storeRawAsset(asset.key, asset.type, asset.data);
        this._resizeHandler = () => this._initCanvas();
        window.addEventListener('resize', this._resizeHandler);
        this._captureFrame();
        this._loop.start();
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
        if (this._primary) this._primary.frameDirty = true;
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
        this.view.setCursorOverride('crosshair');
        this._updateInputAttachment();
    }

    disablePick() {
        if (!this._pick || !this.canvas) { this._pick = null; return; }
        this.canvas.removeEventListener('mousemove', this._pick.move);
        this.canvas.removeEventListener('click', this._pick.click);
        this.canvas.removeEventListener('mouseleave', this._pick.leave);
        this.view.setCursorOverride(null);
        this._pick = null;
        this._updateInputAttachment();
    }

    // The primary player's game input is suspended while a recorded frame is
    // pinned or pick mode is active. Extra players are unaffected.
    _updateInputAttachment() {
        if (!this.inputHandler) return; // frozen/stopped sessions cannot resume input
        if (this._inspectBuf || this._pick) this.inputHandler.detach();
        else this.inputHandler.attach();
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
        else if (this._primary) this._primary.frameDirty = true;
    }

    _paintInspectedFrame() {
        if (!this._inspectBuf || !this.renderer) return;
        this.renderer.renderFrame(this._inspectBuf, this.unsquish, { muteAudio: true, freezeMedia: true });
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
    addPlayer(containerId, { gamepadIndex } = {}) {
        if (!this.game || !this.squisher) return null;
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('[LocalSession] addPlayer: container not found: #' + containerId);
            return null;
        }

        const playerId = Math.max(...this.players.map(p => p.playerId)) + 1;
        // Split controllers between seats; explicit indices support sparse pad lists.
        const primaryPads = this.inputHandler?.gamepads;
        if (primaryPads && primaryPads.index === null) primaryPads.setIndex(0);
        const usedIndices = new Set(this.players.map(p => p.view?.inputHandler.gamepads?.index));
        if (gamepadIndex === undefined) {
            gamepadIndex = 0;
            while (usedIndices.has(gamepadIndex)) gamepadIndex++;
        }
        this._joinPlayer(container, playerId, generateName(),
            this.gamepadOptions === false ? false : { ...this.gamepadOptions, index: gamepadIndex });
        this._captureFrame();
        return playerId;
    }

    _joinPlayer(container, playerId, playerName, gamepad) {
        const dispatcher = new LocalDispatcher(this.game, playerId);
        const view = new GameView({
            container, assetManager: this.assetManager, gamepad,
            send: msg => {
                if (playerId === this.playerId) this._noteInput(msg);
                dispatcher.handleMessage(msg);
            },
            onAssetReady: () => this._invalidateFrames(),
        });
        this.players.push({ playerId, info: { name: playerName }, settings: { SOUND: true }, view, dispatcher, cursor: null, currentBuf: null, frameDirty: true });
        if (playerId === this.playerId) {
            const device = new MediaClient({ container, platform: this.platform, assets: view.assetManager,
                send: message => this.media.handle(playerId, message),
                publish: (id, stream) => this.media.attach(playerId, stream),
            });
            this.media.join(playerId, { audioRecording: true, send: message => device.receive(message),
                addMedia: (id, stream) => device.attach(stream), removeMedia: id => device.remove(id) });
        }
        view.inputHandler.squishVersion = this.squishVersion;
        view.inputHandler.setPointerLockEnabled(this.pointerLockEnabled);
        view.resize(this.aspectRatio);
        try {
            this.game.handleNewPlayer?.({ playerId, settings: { SOUND: true },
                info: { name: playerName }, clientInfo: getClientInfo(), requestedGame: null });
        } catch (e) {
            console.error('[LocalSession] game.handleNewPlayer threw:', e);
        }
    }

    _leavePlayer(player) {
        this.projectTransfers?.leave(player.playerId);
        this.media?.leave(player.playerId);
        const dispatcher = player.dispatcher;
        if (!dispatcher) return; // already left, including freeze() followed by stop()
        player.dispatcher = null;
        player.view?.setCursor(null);
        if (player.cursor) {
            // A departing remote transport may already be closed. Its reset
            // must not prevent the rest of the seat from being released.
            try { player.send?.(encodeCursor(null)); } catch (e) {}
        }
        delete player.cursor;
        player.view?.inputHandler.setPointerLockEnabled(false);
        player.view?.inputHandler.detach();
        dispatcher.release();
        try { this.game?.handlePlayerDisconnect?.(player.playerId); } catch (e) {}
        player.view?.renderer.stopAllSounds();
    }

    removePlayer(playerId) {
        const index = this.players.findIndex(p => p.playerId === playerId);
        if (index <= 0) return; // the primary view lives until the session ends
        const [player] = this.players.splice(index, 1);
        this._leavePlayer(player);
        player.view?.destroy();
        player.close?.();
    }

    // A remote seat uses the same game, dispatcher and frame capture as a
    // local view. Its transport owns rendering on the other device.
    addRemotePlayer({ send, close, clientInfo = {}, playerName }) {
        if (!this.game || this.frozen) throw new Error('The host game has ended');
        if (this.players.length >= this.maxPlayers) throw new Error('This game is full');
        let playerId = 1;
        while (this.players.some(p => p.playerId === playerId)) playerId++;
        const version = Array.from(this.squishVersion, c => c.charCodeAt(0));
        // Legacy init ended after the version. Older clients ignore this optional
        // trailing input-flags byte; bit 0 enables user-initiated mouse capture.
        // send(Uint8Array.from([2, playerId, this.aspectRatio.x, this.aspectRatio.y, 0, 0, version.length, ...version]));
        send(Uint8Array.from([2, playerId, this.aspectRatio.x, this.aspectRatio.y, 0, 0, version.length, ...version, this.pointerLockEnabled ? 1 : 0]));
        for (const packet of this.assetPackets) send(packet);
        // Each upload fits one RTC packet; all past uploads together may not.
        for (const asset of this.dynamicAssets.values()) send(packAssetBundle([asset]));
        const dispatcher = new LocalDispatcher(this.game, playerId);
        const player = { playerId, info: { name: initialName(playerName) }, settings: { SOUND: true }, dispatcher, send, close, view: null, cursor: null, currentBuf: null, frameDirty: true };
        this.players.push(player);
        try {
            this.game.handleNewPlayer?.({ playerId, settings: { SOUND: true },
                info: { ...player.info }, clientInfo, requestedGame: null });
            this._captureFrame();
        } catch (err) { this.removePlayer(playerId); throw err; }
        return {
            playerId,
            handleMessage: message => {
                if (!player.dispatcher) return;
                let value; try { value = JSON.parse(message); } catch (_) { return; }
                if (value?.type === 'player-info') {
                    // The transport owns the seat; never trust a supplied playerId.
                    try { this.setPlayerName(playerId, value.name); } catch (_) {}
                }
                else if (value?.type === 'project-transfer') this.handleProjectMessage(playerId, value, send);
                else player.dispatcher.handleInput(value);
            },
            leave: () => this.removePlayer(playerId),
        };
    }

    setPlayerName(playerId, value) {
        const name = normalizeName(value);
        // A menu can be used while saved progress is still loading.
        if (playerId === this.playerId) this.playerName = name;
        const player = this.players.find(p => p.playerId === playerId && p.dispatcher);
        if (!player || !this.game || this.frozen) return false;
        if (player.info.name === name) return name;
        player.info = { ...player.info, name };
        try { this.game.handlePlayerUpdate?.(playerId, { info: { ...player.info }, settings: { ...player.settings } }); }
        catch (error) { console.error('[LocalSession] game.handlePlayerUpdate threw:', error); }
        this._captureFrame();
        return name;
    }

    exportProject(playerId) {
        if (!this.runtime || this.frozen || !this.players.some(p => p.playerId === Number(playerId) && p.dispatcher)) return Promise.reject(new Error('Join the game before requesting a copy'));
        return this.runtime.exportProject(Number(playerId));
    }

    handleProjectMessage(playerId, message, send) {
        if (!this.players.some(p => p.playerId === Number(playerId) && p.dispatcher)) return;
        void this.projectTransfers?.handle(Number(playerId), message, send);
    }

    // Cursor selection belongs to the seat, independently of the scene or
    // pointer location. The game explicitly chooses when to set or clear it.
    setCursor(playerId, cursor) {
        if (!this.game || !this.runtime || this.frozen) return false;
        const player = this.players.find(p => p.playerId === Number(playerId) && p.dispatcher);
        if (!player) return false;
        const normalized = normalizeCursor(cursor);
        player.cursor = normalized;
        if (player.view) player.view.setCursor(normalized);
        else player.send(encodeCursor(normalized));
        return true;
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
        this._endGame();
    }

    // Both freeze and stop end exactly the same runtime. Views outlive the
    // game only when frozen, so inspector recordings remain available.
    _endGame() {
        this._bootGeneration = (this._bootGeneration || 0) + 1;
        const onStop = this.onStop;
        this.onStop = null;
        onStop?.();
        this.media?.destroy();
        this.projectTransfers?.close();
        this.runtime?.stop();
        this.runtime = null;
        this.players.forEach(player => this._leavePlayer(player));
        this.pointerLockEnabled = false;
        try { this.game?.close?.(); } catch (e) {}
        try { this.game?.destroy?.(); } catch (e) {}
        this.game = null;
    }

    stop() {
        this._endGame();
        this._loop.stop();
        this.disablePick();
        this._inspector = null;
        this._onInput = null;
        this._inspectBuf = null;
        this._highlight = null;
        this.frozen = false;
        // Borrowed views go first; the primary owns their shared asset store.
        [...this.players].reverse().forEach(player => { player.view?.destroy(); player.close?.(); });
        this.players = [];
        this.dynamicAssets.clear();
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
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
            if (data) {
                this.dynamicAssets.set(key, { key, type, data });
                this.assetManager?.storeRawAsset(key, type, data);
                const bundle = packAssetBundle([{ key, type, data }]);
                this.players.forEach(player => player.send?.(bundle));
                this._invalidateFrames();
            }
        } catch (err) {
            console.error('[LocalSession] addAsset failed:', err);
        }
        return Promise.resolve();
    }

    // Mirrors GameSession._sendPlayerFrame: flush pending changes and filter
    // the snapshot for this viewer, including players with no private nodes.
    _captureFrame() {
        const squisher = this.squisher;
        if (!squisher) return;
        squisher.flush?.();
        if (this.squisher !== squisher) return; // a snapshot callback may end the game

        for (const player of this.players) {
            const frame = playerFrame(squisher, player.playerId);
            if (!frame?.length) continue;
            // Squish emits fractional values for integer bytes. Match the
            // hosted Buffer truncation; Uint8ClampedArray alone would round.
            // A remote frame is newly allocated for this seat and has no local
            // renderer. Hand ownership to communication instead of retaining a
            // buffer that would be detached when posted to the worker.
            if (player.view) { player.currentBuf = frame; player.frameDirty = true; }
            player.send?.(frame, { transfer: true });
        }
        this._emitSnapshot();
    }

    _invalidateFrames() {
        this.players.forEach(player => {
            player.frameDirty = true;
            player.view?.refreshCursor();
        });
    }

    _initCanvas() {
        this.players.forEach(player => player.view?.resize(this.aspectRatio));
        this._invalidateFrames();
        if (this._inspectBuf) this._paintInspectedFrame();
    }

    _paintFrame() {
        for (const player of this.players) {
            const { view } = player;
            if (!view) continue;
            if (player.dispatcher) view.inputHandler.tick();
            if (view.destroyed) continue; // input can stop the session or remove this seat
            const { currentBuf } = player; // input can synchronously update the frame
            if ((!player.frameDirty && !view.renderer.needsRepaint()) || !currentBuf || currentBuf.length <= 1 || currentBuf[0] !== 3) continue;
            const primary = player === this._primary;
            if (!primary || !this._inspectBuf) {
                view.renderer.renderFrame(currentBuf, this.unsquish, { muteAudio: !primary || this.frozen, freezeMedia: this.frozen });
                if (primary) this._drawHighlight();
            }
            player.frameDirty = false;
        }
    }

}

module.exports = LocalSession;
