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
     */
    constructor(opts) {
        this.containerId = opts.containerId;
        this.wsUrl = opts.wsUrl;
        this.workerUrl = opts.workerUrl || null;
        this.onReady = opts.onReady || (() => {});
        this.onClose = opts.onClose || (() => {});
        this.onError = opts.onError || (() => {});
        this.spectating = opts.spectating || false;
        this.requestedGame = opts.requestedGame || null;

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
                if (!this.rendering) {
                    this.rendering = true;
                    this._renderLoop();
                }
                break;

            case 5: // Port redirect (join game session)
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
        }
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
    }

    _renderLoop() {
        if (!this.rendering) return;

        // Process input
        if (this.inputHandler) {
            this.inputHandler.tick();
        }

        // Render current frame
        if (this.currentBuf && this.currentBuf.length > 1 && this.currentBuf[0] === 3 && this.unsquish) {
            this.renderer.renderFrame(this.currentBuf, this.unsquish);
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

// Export for both CommonJS and browser global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { default: HomegamesClient, HomegamesClient };
}
if (typeof window !== 'undefined') {
    window.HomegamesClient = HomegamesClient;
}
