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
 * Usage (Web Worker WebSocket — keeps binary processing off main thread):
 *   const client = new HomegamesClient({
 *       containerId: 'game-div',
 *       wsUrl: 'ws://localhost:8300',
 *       workerUrl: '/socket-worker.js',
 *   });
 *   client.start();
 */

const { squishMap, DEFAULT_VERSION } = require('./squish-map');
const AssetManager = require('./assets');
const Renderer = require('./renderer');
const InputHandler = require('./input');
const LocalSession = require('./local-session');
const { createSaveStore } = require('./save-store');

class HomegamesClient {
    /**
     * @param {object} opts
     * @param {string} opts.containerId — ID of the DOM element to render into
     * @param {string} opts.wsUrl — WebSocket URL of the game session
     * @param {string} [opts.workerUrl] — URL to the socket-worker.js file. If provided, uses a Web Worker for the WebSocket.
     * @param {function} [opts.onReady] — callback(playerId) when session is ready
     * @param {function} [opts.onClose] — callback when WebSocket closes
     * @param {function} [opts.onError] — callback(error) on error
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
     */
    constructor(opts) {
        this.containerId = opts.containerId;
        this.wsUrl = opts.wsUrl;
        this.workerUrl = opts.workerUrl || null;
        this.onReady = opts.onReady || (() => {});
        this.onClose = opts.onClose || (() => {});
        this.onError = opts.onError || (() => {});
        this.onSaveData = opts.onSaveData || (() => {});
        this.onLocalPlayRedirect = opts.onLocalPlayRedirect || null;
        this._localSession = null;
        this._localChrome = null;
        this.spectating = opts.spectating || false;
        this.requestedGame = opts.requestedGame || null;

        // Browser-side save persistence, scoped by server host — used when
        // the server runs the broadcast save backend (opcodes 10/11).
        this.saveStore = opts.saveStore || createSaveStore();

        this.ws = null;
        this.worker = null;
        this.canvas = null;
        this.container = null;
        this.assetManager = null;
        this.renderer = null;
        this.inputHandler = null;

        this.playerId = null;
        this.aspectRatio = null;
        this.bezelInfo = { x: 0, y: 0 };
        this.squishVersion = null;
        this.unsquish = null;

        this.currentBuf = null;
        this.rendering = false;
        // Only re-unsquish + redraw when something actually changed (new state
        // buffer, resize, or aspect-ratio change). Avoids burning a full frame
        // decode + canvas repaint 60x/sec while the game is idle.
        this._frameDirty = false;
        this._rafId = null;
        this._resizeHandler = null;
    }

    /**
     * Connect to the game session and start rendering.
     */
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

        // --- Set up subsystems ---
        this.assetManager = new AssetManager();
        // When an asset finishes loading async (image/font/audio), repaint the
        // current frame — it may have rendered before the asset was ready.
        this.assetManager.onAssetReady = () => { this._frameDirty = true; };
        this.renderer = new Renderer(this.canvas, this.assetManager);
        this.inputHandler = new InputHandler(
            this.canvas,
            (msg) => this._send(msg),
            () => this.renderer.thingIndices,
            this.assetManager
        );
        this.inputHandler.attach();

        // --- Handle resize ---
        this._resizeHandler = () => {
            this._initCanvas();
            // Send updated client info on resize
            this._sendClientInfo();
        };
        window.addEventListener('resize', this._resizeHandler);

        // --- Connect ---
        if (this.workerUrl) {
            this._connectWorker();
        } else {
            this._connectInline();
        }
    }

    /**
     * Disconnect and clean up everything.
     */
    stop() {
        this.rendering = false;

        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        if (this.worker) {
            this.worker.postMessage({ type: 'close' });
            this.worker.terminate();
            this.worker = null;
        }

        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }

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

    // -----------------------------------------------------------------------
    // Send — routes to either WebSocket or Worker
    // -----------------------------------------------------------------------

    _send(msg) {
        if (this.worker) {
            this.worker.postMessage({ type: 'send', data: msg });
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    _sendClientInfo() {
        const clientInfo = this._getClientInfo();
        if (this.worker) {
            this.worker.postMessage({ type: 'send', data: JSON.stringify({ clientInfo }) });
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ clientInfo }));
        }
    }

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

        this.ws.onopen = () => {
            const readyMsg = {
                type: 'ready',
                spectating: this.spectating,
                clientInfo: { clientInfo: this._getClientInfo() },
            };
            if (this.requestedGame) {
                readyMsg.clientInfo.requestedGame = this.requestedGame;
            }
            this.ws.send(JSON.stringify(readyMsg));
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinaryMessage(new Uint8ClampedArray(event.data));
            }
        };

        this.ws.onclose = () => {
            this.rendering = false;
            this.onClose();
        };

        this.ws.onerror = (err) => {
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

        this.worker.onmessage = (event) => {
            const data = event.data;

            if (data instanceof ArrayBuffer) {
                this._handleBinaryMessage(new Uint8ClampedArray(data));
            } else if (data && data.type === 'open') {
                // Worker opened the socket — send ready
                this.worker.postMessage({
                    type: 'sendReady',
                    id: this.playerId,
                    spectating: this.spectating,
                    clientInfo: { clientInfo: this._getClientInfo() },
                    requestedGame: this.requestedGame,
                });
            } else if (data && data.type === 'close') {
                this.rendering = false;
                this.onClose();
            } else if (data && data.type === 'error') {
                this.onError(new Error(data.message));
            }
        };

        this.worker.onerror = (err) => {
            this.onError(err);
        };

        // Tell worker to connect
        this.worker.postMessage({ type: 'connect', wsUrl: this.wsUrl });
    }

    // -----------------------------------------------------------------------
    // Reconnect (for port redirects) — works with either mode
    // -----------------------------------------------------------------------

    _reconnect(newWsUrl) {
        this.wsUrl = newWsUrl;
        this.rendering = false;
        this.currentBuf = null;

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
            case 2: // Init message
                this._handleInit(buf);
                break;

            case 1: // Asset bundle
                this.assetManager.storeAssets(buf);
                break;

            case 3: // Game state frame
                this.currentBuf = buf;
                this._frameDirty = true;
                if (!this.rendering) {
                    this.rendering = true;
                    this._renderLoop();
                }
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
        if (!info || !info.gameKey) return;

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
    startLocalGame({ gameKey, versionId = null } = {}) {
        const versionQuery = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
        fetch(`/games/${encodeURIComponent(gameKey)}/local-manifest${versionQuery}`)
            .then(r => {
                if (!r.ok) throw new Error('Manifest fetch failed: ' + r.status);
                return r.json();
            })
            .then(manifest => {
                if (!manifest.localPlayable) {
                    throw new Error(manifest.reason || 'This game cannot run in single player');
                }
                const bundlePromise = manifest.assetCount > 0
                    ? fetch(manifest.assetBundleUrl).then(r => {
                        if (!r.ok) throw new Error('Asset bundle fetch failed: ' + r.status);
                        return r.arrayBuffer();
                    }).then(ab => new Uint8ClampedArray(ab))
                    : Promise.resolve(null);

                return bundlePromise.then(assetBundle => ({ manifest, assetBundle }));
            })
            .then(({ manifest, assetBundle }) => {
                // Everything fetched — only now leave the current session, so a
                // failed fetch leaves the player where they were.
                this.stop();

                const gameAreaId = this._buildLocalChrome(manifest.name || gameKey);

                this._localSession = new LocalSession({
                    containerId: gameAreaId,
                    files: manifest.files,
                    entryPoint: manifest.entryPoint,
                    assetBundle,
                    gameKey,
                    onSaveData: this.onSaveData,
                    onError: (err) => {
                        console.error('Local session error:', err);
                        this.onError(err);
                    },
                });
                this._localSession.start();
            })
            .catch(err => {
                console.error(err);
                this.onError(err);
            });
    }

    /**
     * Leave the local game and reconnect to the session this client came
     * from — the home port dashboard.
     */
    exitLocalGame() {
        if (this._localSession) {
            this._localSession.stop();
            this._localSession = null;
        }
        this._removeLocalChrome();
        this.start();
    }

    // Local-play chrome: a real HTML header bar OUTSIDE the game canvas —
    // home button + game title — with the game rendering into its own area
    // below (the canvas letterboxes to the game's aspect ratio in there, so
    // nothing ever draws over it). Returns the id of the game area element
    // for LocalSession to render into.
    _buildLocalChrome(title) {
        this._removeLocalChrome();
        const container = document.getElementById(this.containerId);
        if (!container) return this.containerId;

        container.innerHTML = '';
        container.style.position = 'relative';
        container.style.background = '#000';

        const bar = document.createElement('div');
        bar.style.cssText = 'height:40px;display:flex;align-items:center;gap:12px;'
            + 'padding:0 10px;background:#4D4D4D;box-sizing:border-box;'
            + 'font-family:sans-serif;';

        const homeButton = document.createElement('div');
        homeButton.style.cssText = 'background:#FFF78E;color:#1a1a1a;padding:5px 14px;'
            + 'border-radius:6px;font-size:14px;cursor:pointer;user-select:none;';
        homeButton.textContent = '⌂ Home';
        homeButton.onclick = () => this.exitLocalGame();
        bar.appendChild(homeButton);

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'color:#fff;font-size:14px;opacity:0.85;';
        titleEl.textContent = title || '';
        bar.appendChild(titleEl);

        const gameArea = document.createElement('div');
        gameArea.id = `${this.containerId}-hg-local-area`;
        gameArea.style.cssText = 'position:relative;width:100%;height:calc(100% - 40px);'
            + 'overflow:hidden;background:#000;';

        container.appendChild(bar);
        container.appendChild(gameArea);
        this._localChrome = { bar, gameArea };

        return gameArea.id;
    }

    _removeLocalChrome() {
        if (this._localChrome) {
            this._localChrome.bar.remove();
            this._localChrome.gameArea.remove();
            this._localChrome = null;
        }
    }

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
            console.warn('Unknown squish version: ' + svStr + ', falling back to ' + DEFAULT_VERSION);
            this.unsquish = squishMap[DEFAULT_VERSION].unsquish;
        }

        // Update input handler
        if (this.inputHandler) {
            this.inputHandler.spectating = this.spectating;
            this.inputHandler.bezelInfo = this.bezelInfo;
            // Gates the held-press behavior: 1.4.4+ gets the single-click
            // contract (mousemove while held), older versions get legacy
            // repeated clicks.
            this.inputHandler.squishVersion = svStr;
        }

        this._initCanvas();
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

        const clientWidth = canvasWidth;
        const clientHeight = canvasHeight;

        if (this.inputHandler) {
            this.inputHandler.clientWidth = clientWidth;
            this.inputHandler.clientHeight = clientHeight;
        }

        // Resizing clears the canvas, so the current frame must be repainted.
        this._frameDirty = true;
    }

    _renderLoop() {
        if (!this.rendering) return;

        // Process input
        if (this.inputHandler) {
            this.inputHandler.tick();
        }

        // Render current frame — only when something changed since the last paint.
        // The input tick above still runs every frame (hover, gamepad polling).
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
HomegamesClient.packAssetBundle = packAssetBundle;
HomegamesClient.fitImageToSize = fitImageToSize;
HomegamesClient.downloadSave = downloadSave;

// Export for both CommonJS and browser global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { default: HomegamesClient, HomegamesClient, LocalSession, packAssetBundle, fitImageToSize, downloadSave };
}
if (typeof window !== 'undefined') {
    window.HomegamesClient = HomegamesClient;
    window.LocalSession = LocalSession;
}
