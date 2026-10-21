const { ProjectTransferClient, CONTROL: PROJECT_CONTROL, CHUNK: PROJECT_CHUNK } = require('homegames-common/project-transfer');
const SessionController = require('./session-controller');
const createLocalChrome = require('./local-game-chrome');
const { loadLocalGame, loadHomeGame } = require('./local-game-loader');
const { GameView, FrameLoop, getClientInfo } = require('./game-view');
const createPlayerSharing = require('./player-sharing');
/**
 * HomegamesClient — Embeddable game client for Homegames.
 *
 * Usage (inline WebSocket):
 *   const client = new HomegamesClient({
 *       containerId: 'game-div',
 *       wsUrl: 'ws://localhost:8300',
 *   });
 *   client.start();
 *
 * Usage (Web Worker WebSocket — keeps socket I/O off the main thread):
 *   const client = new HomegamesClient({
 *       containerId: 'game-div',
 *       wsUrl: 'ws://localhost:8300',
 *       workerUrl: '/socket-worker.js',
 *   });
 *   client.start();
 */

const { squishMap, DEFAULT_VERSION } = require('./squish-map');
const LocalSession = require('./local-session');
const MediaClient = require('./media-client');
const { RtcHost, createRtcTransport, readInvitation } = require('./rtc-session');
const { createSaveStore } = require('./save-store');
const { CURSOR_OPCODE, decodeCursor } = require('homegames-common/cursor');

class HomegamesClient {
    /**
     * @param {object} opts
     * @param {string} opts.containerId — ID of the DOM element to render into
     * @param {string} opts.wsUrl — WebSocket URL of the game session
     * @param {string} [opts.workerUrl] — URL to the socket-worker.js file. If provided, uses a Web Worker for the WebSocket.
     * @param {function} [opts.onReady] — callback(playerId) when session is ready
     * @param {function} [opts.onClose] — callback when WebSocket closes
     * @param {function} [opts.onError] — callback(error) on error
     * @param {function} [opts.onAspectRatio] — callback({ x, y }) when the game
     *        aspect ratio changes, for an embedding player's frame.
     * @param {boolean} [opts.spectating] — connect as spectator (default false)
     * @param {object} [opts.requestedGame] — { gameId, versionId } to request
     * @param {function} [opts.onLocalPlayRedirect] — callback({ gameKey, versionId })
     *        when the server asks this client to run a game single-player.
     *        Default: swap to an in-place LocalSession fed by the serving
     *        origin's /games/:gameKey/local-manifest endpoint (as
     *        homegames-core serves), with a home button back to the session.
     * @param {function} [opts.onSaveData] — callback(envelope) when the server
     *        pushes a save (servers with save files disabled deliver saves to
     *        clients instead). The envelope is already persisted locally;
     *        embedders can offer a download via HomegamesClient.downloadSave.
     * @param {function} [opts.loadLocalGame] — async (request, { signal }) =>
     *        { files, entryPoint, assetBundle, gameKey, versionId, name }.
     *        Override the default home-server manifest loader for another host.
     * @param {boolean|string} [opts.localHome] — false hides Home; a URL returns
     *        to that page. Otherwise Home reconnects to the WebSocket dashboard.
     */
    constructor(opts) {
        this.containerId = opts.containerId;
        this.wsUrl = opts.wsUrl;
        this.workerUrl = opts.workerUrl || null;
        this.transportFactory = opts.transport || null;
        this.transport = null;
        this.onReady = opts.onReady || (() => {});
        this.onClose = () => {
            // A failed join often emits error and then close. Keep the useful
            // failure reason (and any host-supplied recovery instructions).
            if (!this._connectionFailed) this._setFrameStatus('Disconnected from the game.', { attention: true });
            opts.onClose?.();
        };
        this.onError = error => {
            this._connectionFailed = true;
            this._setFrameStatus(error?.message || 'Unable to connect to the game.', { attention: true });
            opts.onError?.(error);
        };
        this.onAspectRatio = opts.onAspectRatio || (() => {});
        this.onSharingStatus = opts.onSharingStatus || (() => {});
        this._toolbarSharingLink = mode => this.getSharingLink(mode);
        this.onSaveData = opts.onSaveData || (() => {});
        this.onLocalPlayRedirect = opts.onLocalPlayRedirect || null;
        this.spectating = opts.spectating || false;
        this.requestedGame = opts.requestedGame || null;
        this.gamepadOptions = opts.gamepad ?? {};

        // Browser-side save persistence, scoped by server host — used when
        // the server runs the broadcast save backend (opcodes 10/11).
        this.saveStore = opts.saveStore || createSaveStore();

        this.platform = opts.platform;
        this._defaultShareOptions = opts.share && typeof opts.share === 'object' ? opts.share : null;
        this._playerProfile = require('homegames-common/player-identity').profile(window);
        this.playerName = opts.playerName === undefined ? this._playerProfile.get() : this._playerProfile.set(opts.playerName);
        this.showChrome = opts.chrome !== false;
        this.onSessionStatus = opts.onSessionStatus || (() => {});
        this.localHome = opts.localHome;
        this.ws = null;
        this.worker = null;
        this.view = null;

        this.playerId = null;
        this.aspectRatio = null;
        this.bezelInfo = { x: 0, y: 0 };
        this.squishVersion = null;
        this.unsquish = null;

        this.currentBuf = null;
        // Only re-unsquish + redraw when something actually changed (new state
        // buffer, resize, or aspect-ratio change). Avoids burning a full frame
        // decode + canvas repaint 60x/sec while the game is idle.
        this._frameDirty = false;
        this._loop = new FrameLoop(() => this._paintFrame());
        this._resizeHandler = null;

        this._sessions = new SessionController({
            remote: { start: () => this._startRemote(), stop: () => this._stopRemote() },
            loadLocal: opts.loadLocalGame || loadHomeGame,
            mountLocal: game => {
                this._shareOptions = typeof opts.share === 'function' ? opts.share(game) : opts.share;
                if (!this.showChrome) return { containerId: this.containerId, dispose() {} };
                const chrome = createLocalChrome(this.containerId, game.name || game.gameKey,
                opts.localHome === false ? null : typeof opts.localHome === 'string' ? opts.localHome : () => this.exitLocalGame(), this._shareOptions ? {
                    getSharingLink: this._toolbarSharingLink,
                    private: this._shareOptions.visibility !== 'public',
                    onVisibility: this._shareOptions.room ? visibility => this._getRtcHost().setVisibility(visibility) : null,
                    onOpen: () => this._localSession?.inputHandler?.detach(),
                    onClose: () => this._localSession?.inputHandler?.attach(),
                } : null, { author: game.author, onExports: () => this.viewExports(),
                    onOpen: () => this.setInputEnabled(false), onClose: () => this.setInputEnabled(true) });
                this._configureToolbar(chrome.toolbar);
                return chrome;
            },
            createLocal: game => new LocalSession({ ...game,
                playerName: this.playerName,
                gamepad: this.gamepadOptions, platform: opts.platform, saveStore: this.saveStore,
                onAspectRatio: this.onAspectRatio,
                onSaveData: this.onSaveData, onError: this.onError, onReady: id => {
                    const solo = this._localSession?.maxPlayers === 1;
                    this._configureSharing(this._localChrome?.toolbar);
                    this.onReady(id);
                    if (this._shareOptions?.autoStart && !solo) {
                        this._getRtcHost().share().catch(err => this._localChrome?.setStatus?.(`Not available to join: ${err.message}. Use Invite to retry.`));
                    }
                },
            }),
            onError: this.onError,
        });
    }

    /**
     * Connect to the game session and start rendering.
     */
    start() { this._sessions.start(); }
    stop() {
        this.disposeSharing();
        this._shareDialog?.dispose(); this._shareDialog = null;
        if (!this._switchingManual) { this._manualPairing?.dispose(); this._manualPairing = null; }
        this._sessions.stop();
    }
    get _localSession() { return this._sessions.local; }
    get _localChrome() { return this._sessions.chrome; }

    _getRtcHost() {
        const session = this._localSession;
        if (!session) throw new Error('The game is still loading');
        if (!this._rtcHost || this._rtcHost.session !== session) {
            this._rtcHost = new RtcHost(session, { ...this._shareOptions,
                onStatus: text => { this._localChrome?.setStatus?.(text); this.onSessionStatus(text); } });
        }
        return this._rtcHost;
    }

    getNetworkStats() {
        return (this._localSession && this._rtcHost?.getStats()) || this.transport?.getStats?.() || Promise.resolve(null);
    }

    // The same Homegames protocol is used by in-process, RTC and WebSocket clients.
    requestGameCopy() { return this._requestFile(); }
    listExports() { return this.spectating && !this._localSession ? Promise.reject(new Error('Join as a player to view exports')) : this._requestFile({ kind: 'export-list' }); }
    readExport(name) { return this.spectating && !this._localSession ? Promise.reject(new Error('Join as a player to save exports')) : this._requestFile({ kind: 'export', name }); }
    async viewExports() {
        if (this._exportsOpen) return;
        this._exportsOpen = true;
        const input = this._localSession?.inputHandler || this.inputHandler;
        input?.detach();
        try {
            if (this.platform?.viewExports) await this.platform.viewExports();
            else {
                this._exportsViewer = require('homegames-common/exports-viewer').createExportsViewer(window, {
                    list: () => this.listExports(), read: name => this.readExport(name) });
                await this._exportsViewer.result;
            }
        } catch (error) { this.onError(error); }
        finally {
            this._exportsViewer = null; this._exportsOpen = false;
            if (input && (input === this._localSession?.inputHandler || (input === this.inputHandler && this.rendering))) input.attach();
        }
    }
    _requestFile(options) {
        if (!this._projectTransfer) this._projectTransfer = new ProjectTransferClient({
            importArchive: bytes => HomegamesClient.PortableProject.importArchive(bytes),
            send: message => {
                const local = this._localSession;
                if (local) {
                    if (!local.runtime || local.frozen || !local.players.some(player => player.playerId === local.playerId && player.dispatcher)) throw new Error('The game is not ready. Try again once it has loaded.');
                    const transfer = this._projectTransfer;
                    queueMicrotask(() => local.handleProjectMessage(local.playerId, message, bytes => {
                        queueMicrotask(() => transfer.receive(bytes));
                    }));
                }
                else this._send(JSON.stringify(message));
            },
        });
        return this._projectTransfer.request(options);
    }

    getShareLink() {
        if (this._localSession && this._shareOptions) return this._getRtcHost().share();
        if (this.transport?.getShareLink) return this.transport.getShareLink();
        throw new Error('This session is not available to share');
    }

    // Both the direct menu and an opaque iframe host use the same invitation
    // and copy provider. Keep copy invitations valid while this game is open.
    getSharingLink(mode) {
        if (!this._localSession && !this.view) return Promise.reject(new Error('The game is still loading. Try again once it is ready.'));
        if (!this._playerSharing) this._playerSharing = createPlayerSharing({
            ...this._shareOptions,
            getInvitation: () => this.getShareLink(),
            getProject: async () => (await this.requestGameCopy()).project,
            onStatus: (text, sharingMode = 'copy') => {
                this._playerToolbar()?.setSharingStatus?.(text, sharingMode);
                this.onSharingStatus(text, sharingMode);
            },
        });
        return this._playerSharing.getLink(mode);
    }

    disposeSharing() {
        this._playerSharing?.dispose();
        this._playerSharing = null;
    }

    _configureSharing(toolbar) {
        if (!toolbar) return;
        if (!this._shareOptions && !this.transport?.getShareLink) {
            toolbar.setSharing?.(null);
            return;
        }
        toolbar.setSharing({
            multiplayer: this._localSession?.maxPlayers !== 1,
            getLink: this._toolbarSharingLink,
        });
    }

    setInputEnabled(enabled) {
        const input = this._localSession?.inputHandler || this.inputHandler;
        if (enabled) {
            input?.attach();
            // Native dialogs restore focus to their launch button. Return it
            // to the game so keyboard play resumes immediately as well.
            input?.canvas.focus?.({ preventScroll: true });
        } else input?.detach();
    }

    _playerToolbar() {
        return this._sessions?.chrome?.toolbar || this._remoteChrome?.toolbar
            || this.container?.closest?.('.hg-session-frame')?.querySelector?.('.hg-session-bar')?.homegamesToolbar;
    }

    _setFrameStatus(text, details) {
        this._playerToolbar()?.setStatus(text, details);
    }

    getPlayerName() { return this.playerName; }
    setPlayerName(value) {
        const name = this._playerProfile.set(value);
        this.playerName = name;
        if (this._localSession) this._localSession.setPlayerName(this._localSession.playerId, name);
        else if (!this.spectating) this._send(JSON.stringify({ type: 'player-info', name }));
        this.platform?.setState?.({ playerName: name });
        return name;
    }

    showShare() {
        if (!this._shareDialog) this._shareDialog = require('./share-dialog')({ container: document.body,
            getLink: () => this.getShareLink(), onOpen: () => this.setInputEnabled(false), onClose: () => this.setInputEnabled(true) });
        this._shareDialog.show();
    }

    _configureToolbar(toolbar) {
        if (!toolbar) return;
        toolbar.setPlayerName(this.playerName, name => this.setPlayerName(name));
        toolbar.setAction('manual-connect', { label: 'Manual connection', run: () => {
            if (!this._manualPairing) this._manualPairing = HomegamesClient.createManualPairing({ container: document.body,
                getSession: () => this._localSession, onOpen: () => this.setInputEnabled(false), onClose: () => this.setInputEnabled(true),
                join: transport => { this._switchingManual = true; this.stop(); this.transportFactory = transport; this.start(); this._switchingManual = false; } });
            this._manualPairing.show();
        } });
    }

    get canvas() { return this.view?.canvas || null; }
    get container() { return this.view?.container || null; }
    get renderer() { return this.view?.renderer || null; }
    get assetManager() { return this.view?.assetManager || null; }
    get inputHandler() { return this.view?.inputHandler || null; }
    get rendering() { return this._loop.running; }

    _startRemote() {
        this._connectionFailed = false;
        this._shareOptions = this._defaultShareOptions;
        let container = document.getElementById(this.containerId);
        if (!container) {
            this.onError(new Error('Container element not found: #' + this.containerId));
            return;
        }

        const bar = container.closest('.hg-session-frame')?.querySelector('.hg-session-bar');
        if (this.showChrome && bar) this._removeExportsButton = createLocalChrome.addExportsButton(bar, () => this.viewExports());
        else if (this.showChrome) {
            this._remoteChrome = createLocalChrome(this.containerId, 'Homegames', typeof this.localHome === 'string' ? this.localHome : null,
                null, { status: 'Connected game', onExports: () => this.viewExports(),
                    onOpen: () => this.setInputEnabled(false), onClose: () => this.setInputEnabled(true) });
            container = this._remoteChrome.gameArea;
        }
        if (this.showChrome) this._configureToolbar((bar || this._remoteChrome?.bar)?.homegamesToolbar);

        this.view = new GameView({
            container, send: msg => this._send(msg),
            gamepad: this.gamepadOptions,
            onAssetReady: () => { this._frameDirty = true; this.view?.refreshCursor(); },
            onLayout: aspectRatio => {
                this.platform?.setState?.({ aspectRatio });
                this.onAspectRatio(aspectRatio);
            },
            onResize: () => { this._frameDirty = true; },
        });

        // --- Handle resize ---
        this._resizeHandler = () => {
            this._initCanvas();
            // Send updated client info on resize
            this._sendClientInfo();
        };
        window.addEventListener('resize', this._resizeHandler);

        // --- Connect ---
        const media = this._mediaClient = new MediaClient({ container, platform: this.platform, assets: this.assetManager,
            send: message => this._send(JSON.stringify(message)),
            publish: (id, stream) => this.transport?.addMedia?.(id, stream),
            unpublish: id => this.transport?.removeMedia?.(id),
        });
        if (this.transportFactory) {
            const generation = this._transportGeneration = (this._transportGeneration || 0) + 1;
            const active = () => generation === this._transportGeneration;
            this.transport = this.transportFactory({
                onOpen: () => { if (active()) this._send(JSON.stringify({ type: 'ready', playerName: this.playerName, media: 1, recording: 2, clientInfo: { clientInfo: getClientInfo() } })); },
                onMessage: data => { if (active() && data instanceof ArrayBuffer) this._handleBinaryMessage(new Uint8ClampedArray(data)); },
                onMedia: message => { if (active()) media.receive(message); },
                onTrack: stream => { if (active()) media.attach(stream); },
                onError: err => { if (active()) this.onError(err); },
                // Previous close handler retained while mouse capture is introduced.
                // onClose: () => { if (active()) { this._loop.stop(); this.view?.setCursor(null); this.inputHandler?.detach(); this.renderer?.stopAllSounds(); media.destroy(); this.onClose(); } },
                onClose: () => { if (active()) { this._loop.stop(); this.view?.setCursor(null); this.inputHandler?.setPointerLockEnabled(false); this.inputHandler?.detach(); this.renderer?.stopAllSounds(); media.destroy(); this.onClose(); } },
            });
        } else if (this.workerUrl) {
            this._connectWorker();
        } else {
            this._connectInline();
        }
    }

    /**
     * Disconnect and clean up everything.
     */
    _stopRemote() {
        this._playerToolbar()?.setSharing?.(null);
        this.disposeSharing();
        this._exportsViewer?.close();
        this.platform?.closeExports?.();
        this._removeExportsButton?.(); this._removeExportsButton = null;
        this._mediaClient?.destroy(); this._mediaClient = null;
        this._projectTransfer?.close(); this._projectTransfer = null;
        this._transportGeneration = (this._transportGeneration || 0) + 1;
        this.inputHandler?.setPointerLockEnabled(false);
        this.transport?.close(); this.transport = null;
        this._loop.stop();

        if (this.worker) {
            this.worker.postMessage({ type: 'close' });
            this.worker.terminate();
            this.worker = null;
        }

        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            ws.close();
        }

        this.view?.destroy();
        this.view = null;
        this._remoteChrome?.dispose(); this._remoteChrome = null;

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
    }

    // -----------------------------------------------------------------------
    // Send — routes to either WebSocket or Worker
    // -----------------------------------------------------------------------

    _send(msg) {
        if (this.transport) {
            this.transport.send(msg);
        } else if (this.worker) {
            this.worker.postMessage({ type: 'send', data: msg });
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    _sendClientInfo() { this._send(JSON.stringify({ clientInfo: getClientInfo() })); }

    // -----------------------------------------------------------------------
    // Inline WebSocket connection (no worker)
    // -----------------------------------------------------------------------

    _connectInline() {
        try {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.binaryType = 'arraybuffer';
        } catch (err) {
            this.onError(err);
            return;
        }

        const ws = this.ws;
        this.ws.onopen = () => {
            if (this.ws !== ws) return;
            const readyMsg = {
                type: 'ready',
                playerName: this.playerName,
                spectating: this.spectating,
                clientInfo: { clientInfo: getClientInfo() },
            };
            if (this.requestedGame) {
                readyMsg.clientInfo.requestedGame = this.requestedGame;
            }
            this.ws.send(JSON.stringify(readyMsg));
        };

        this.ws.onmessage = (event) => {
            if (this.ws !== ws) return;
            if (event.data instanceof ArrayBuffer) {
                this._handleBinaryMessage(new Uint8ClampedArray(event.data));
            }
        };

        this.ws.onclose = () => {
            if (this.ws !== ws) return;
            this._loop.stop();
            this.view?.setCursor(null);
            this.inputHandler?.setPointerLockEnabled(false);
            this.onClose();
        };

        this.ws.onerror = (err) => {
            if (this.ws !== ws) return;
            this.onError(err);
        };
    }

    // -----------------------------------------------------------------------
    // Web Worker WebSocket connection
    // -----------------------------------------------------------------------

    _connectWorker() {
        try {
            this.worker = new Worker(this.workerUrl);
        } catch (err) {
            console.warn('Failed to create Web Worker, falling back to inline WebSocket:', err);
            this._connectInline();
            return;
        }

        const worker = this.worker;
        this.worker.onmessage = (event) => {
            if (this.worker !== worker) return;
            const data = event.data;

            if (data instanceof ArrayBuffer) {
                this._handleBinaryMessage(new Uint8ClampedArray(data));
            } else if (data && data.type === 'open') {
                // Worker opened the socket — send ready
                this.worker.postMessage({
                    type: 'sendReady',
                    playerName: this.playerName,
                    id: this.playerId,
                    spectating: this.spectating,
                    clientInfo: { clientInfo: getClientInfo() },
                    requestedGame: this.requestedGame,
                });
            } else if (data && data.type === 'close') {
                this._loop.stop();
                this.view?.setCursor(null);
                this.inputHandler?.setPointerLockEnabled(false);
                this.onClose();
            } else if (data && data.type === 'error') {
                this.onError(new Error(data.message));
            }
        };

        this.worker.onerror = (err) => {
            if (this.worker !== worker) return;
            this.onError(err);
        };

        // Tell worker to connect
        this.worker.postMessage({ type: 'connect', wsUrl: this.wsUrl });
    }

    // -----------------------------------------------------------------------
    // Reconnect (for port redirects) — works with either mode
    // -----------------------------------------------------------------------

    _reconnect(newWsUrl) {
        this._playerToolbar()?.setSharing?.(null);
        this.disposeSharing();
        this._connectionFailed = false;
        this._exportsViewer?.close(); this.platform?.closeExports?.();
        this._projectTransfer?.close(); this._projectTransfer = null;
        this.wsUrl = newWsUrl;
        this._loop.stop();
        this.currentBuf = null;
        this.view?.setCursor(null);
        this.inputHandler?.setPointerLockEnabled(false);

        // Clear stale state from previous session
        if (this.renderer) {
            this.renderer.stopAllSounds();
            this.renderer.thingIndices = [];
        }
        if (this.assetManager) {
            this.assetManager.assets = {};
            this.assetManager.imageCache = {};
        }

        if (this.worker) {
            this.worker.postMessage({ type: 'connect', wsUrl: newWsUrl });
        } else {
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.close();
            }
            this._connectInline();
        }
    }

    // -----------------------------------------------------------------------
    // Binary message handling (shared by both modes)
    // -----------------------------------------------------------------------

    _handleBinaryMessage(buf) {
        if (buf.length === 0) return;

        const msgType = buf[0];

        switch (msgType) {
            case 16: // Homegames recorded-media control (WebSocket hosts)
                try { this._mediaClient?.receive(JSON.parse(new TextDecoder().decode(buf.subarray(1)))); } catch (_) {}
                break;
            case PROJECT_CONTROL:
            case PROJECT_CHUNK:
                void this._projectTransfer?.receive(buf);
                break;
            case 2: // Init message
                this._handleInit(buf);
                if (!this.transportFactory) this._send(JSON.stringify({type:'media',action:'hello',recording:2}));
                break;

            case 1: // Asset bundle
                this.assetManager.storeAssets(buf);
                // Some non-image assets (e.g. audio before sound unlock) have
                // no ready callback yet. Replacing a selected image with one
                // must still restore the native cursor immediately.
                this.view?.refreshCursor();
                break;

            case 3: // Game state frame
                this.currentBuf = buf;
                this._frameDirty = true;
                this._loop.start();
                break;

            case 5: // Port redirect (join game session)
                // A join redirect always means "connect as a player" — clear
                // any spectator state so a spectator's Join actually drops
                // them back in (otherwise the reconnect re-announces
                // spectating: true and they're stuck watching forever).
                this.spectating = false;
                this._handlePortRedirect(buf);
                break;

            case 6: // Port redirect (spectate)
                this.spectating = true;
                this._handlePortRedirect(buf);
                break;

            case 9: // Aspect ratio update
                this.aspectRatio = { x: buf[1], y: buf[2] };
                this._initCanvas();
                break;

            case 10: // Save data push (server persists nothing — we do)
                this._handleSavePush(buf);
                break;

            case 11: // Save data request (server asks for our stored save)
                this._handleSaveRequest(buf);
                break;

            case 12: // Single player — swap this client to an in-place LocalSession
                this._handleLocalPlayRedirect(buf);
                break;

            case CURSOR_OPCODE: { // Session-selected cursor for this player
                try {
                    this.view?.setCursor(decodeCursor(buf));
                } catch (_) { /* Ignore malformed optional control messages. */ }
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Single player (in-place LocalSession)
    // -----------------------------------------------------------------------

    _handleLocalPlayRedirect(buf) {
        let info;
        try {
            info = JSON.parse(new TextDecoder().decode(buf.slice(1)));
        } catch (e) {
            console.error('Bad local play payload', e);
            return;
        }
        if (!info || (!info.gameKey && !info.invitation)) return;

        if (this.onLocalPlayRedirect) {
            this.onLocalPlayRedirect(info);
            return;
        }

        this.startLocalGame(info);
    }

    /**
     * Run a game single-player in this container: fetch its source + assets
     * from the serving origin's local-manifest endpoints, disconnect from the
     * session, and boot a LocalSession in place. A home button overlay exits
     * back to the session this client was connected to (the home port).
     */
    startLocalGame(request) { return this._sessions.startLocal(request); }
    exitLocalGame() { this._sessions.start(); }

    // -----------------------------------------------------------------------
    // Save games (broadcast backend — server keeps nothing, clients do)
    // -----------------------------------------------------------------------

    // Saves are keyed by server host + gameKey so one server's saves never
    // leak into sessions on another. Port is excluded on purpose: each game
    // session runs on its own port of the same host.
    _saveKey(gameKey) {
        let host = '';
        try {
            host = new URL(this.wsUrl).hostname;
        } catch (e) {}
        return host + ':' + gameKey;
    }

    // Decode a binary frame whose payload (after the opcode byte) is UTF-8 JSON.
    _decodeJsonPayload(buf) {
        try {
            const bytes = new Uint8Array(buf.buffer, buf.byteOffset + 1, buf.length - 1);
            const text = (typeof TextDecoder !== 'undefined')
                ? new TextDecoder().decode(bytes)
                : String.fromCharCode.apply(null, bytes);
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    }

    _handleSavePush(buf) {
        const envelope = this._decodeJsonPayload(buf);
        if (!envelope || typeof envelope.gameKey !== 'string') return;
        this.saveStore.putSave(this._saveKey(envelope.gameKey), envelope).catch(() => {});
        try {
            this.onSaveData(envelope);
        } catch (e) {
            console.error('[HomegamesClient] onSaveData callback threw:', e);
        }
    }

    _handleSaveRequest(buf) {
        const request = this._decodeJsonPayload(buf);
        if (!request || typeof request.gameKey !== 'string') return;
        const respond = (save) => {
            this._send(JSON.stringify({ type: 'saveData', gameKey: request.gameKey, save: save || null }));
        };
        this.saveStore.getSave(this._saveKey(request.gameKey))
            .then(respond)
            .catch(() => respond(null));
    }

    _handleInit(buf) {
        this.playerId = buf[1];
        // A fresh init is a new input contract. Old/short init messages must
        // clear a previous game's opt-in instead of inheriting mouse capture.
        this.inputHandler?.setPointerLockEnabled(false);

        if (buf.length <= 2) return;

        this.aspectRatio = { x: buf[2], y: buf[3] };
        this.bezelInfo = { x: buf[4], y: buf[5] };

        // Parse squish version string
        const svLen = buf[6];
        const svStr = String.fromCharCode.apply(null, buf.slice(7, 7 + svLen));
        this.squishVersion = svStr;

        // Load the right squish module
        const squishModule = squishMap[svStr];
        if (squishModule) {
            this.unsquish = squishModule.unsquish;
        } else {
            this.stop();
            this.onError(new Error('Unsupported Squish runtime: squish-' + svStr));
            return;
        }

        // Update input handler
        if (this.inputHandler) {
            this.inputHandler.spectating = this.spectating;
            this.inputHandler.bezelInfo = this.bezelInfo;
            // Gates the held-press behavior: 1.4.4+ gets the single-click
            // contract (mousemove while held), older versions get legacy
            // repeated clicks.
            this.inputHandler.squishVersion = svStr;
            const inputFlags = buf[7 + svLen] || 0;
            this.inputHandler.setPointerLockEnabled((inputFlags & 1) !== 0);
        }

        this._initCanvas();
        this._connectionFailed = false;
        this._setFrameStatus('Connected game', { attention: false });
        this._configureSharing(this._playerToolbar());
        this.onReady(this.playerId);
    }

    _handlePortRedirect(buf) {
        const a = String(buf[1]);
        const b = String(buf[2]).length > 1 ? String(buf[2]) : '0' + String(buf[2]);
        const newPort = Number(a + b);

        // Reconnect to new port on same host
        const url = new URL(this.wsUrl);
        url.port = newPort;
        this._reconnect(url.toString());
    }

    _initCanvas() {
        if (!this.aspectRatio || !this.container) return;

        this.view.resize(this.aspectRatio);

        // Resizing clears the canvas, so the current frame must be repainted.
        this._frameDirty = true;
    }

    _paintFrame() {
        if (!this.rendering) return;

        // Process input
        this.inputHandler?.tick();

        // Render current frame — only when something changed since the last paint.
        // The input tick above still runs every frame (hover, gamepad polling).
        if ((this._frameDirty || this.renderer.needsRepaint()) && this.currentBuf && this.currentBuf.length > 1 && this.currentBuf[0] === 3 && this.unsquish) {
            this.renderer.renderFrame(this.currentBuf, this.unsquish);
            this._frameDirty = false;
        }
    }

}

const { packAssetBundle } = require('./asset-bundle');
const { fitImageToSize } = require('./image-fit');

// Hand a save envelope to the user as a downloadable JSON file. Embedders
// call this from their onSaveData UI ("game saved — download").
const downloadSave = (envelope, filename) => {
    if (!envelope || typeof document === 'undefined') return;
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename || ((envelope.gameKey || 'game') + '-save.json');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
};

// LocalSession, packAssetBundle, fitImageToSize, and downloadSave ride along
// as statics so they survive the UMD build's single default export
// (library.export: 'default' in webpack.config.js).
HomegamesClient.LocalSession = LocalSession;
HomegamesClient.loadLocalGame = loadLocalGame;
HomegamesClient.packAssetBundle = packAssetBundle;
HomegamesClient.fitImageToSize = fitImageToSize;
HomegamesClient.downloadSave = downloadSave;
HomegamesClient.createRtcTransport = createRtcTransport;
HomegamesClient.readInvitation = readInvitation;
HomegamesClient.RtcHost = RtcHost;
HomegamesClient.createShareDialog = require('./share-dialog');
HomegamesClient.createPlayerSharing = createPlayerSharing;
HomegamesClient.GameCopies = require('./rtc-copy');
HomegamesClient.createSessionFrame = createLocalChrome;
HomegamesClient.createPlayerToolbar = require('homegames-common/player-toolbar').createPlayerToolbar;
HomegamesClient.householdRoom = require('./household-room');
HomegamesClient.PortableProject = require('./portable-project');
HomegamesClient.ManualRtc = require('./rtc-manual');
HomegamesClient.createManualPairing = require('./manual-pairing-ui');

// Export for both CommonJS and browser global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { default: HomegamesClient, HomegamesClient, LocalSession, loadLocalGame, packAssetBundle, fitImageToSize, downloadSave };
}
if (typeof window !== 'undefined') {
    window.HomegamesClient = HomegamesClient;
    window.LocalSession = LocalSession;
}
