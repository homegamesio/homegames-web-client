const AssetManager = require('./assets');
const Renderer = require('./renderer');
const InputHandler = require('./input');

// The browser surface is independent of where the game runs. Local/remote
// sessions own game state and feed frames into this view. Extra Studio views
// borrow the primary asset store, and therefore must not dispose that store.
class GameView {
    constructor({ container, assetManager, send, gamepad, onAssetReady }) {
        this.container = container;
        container.innerHTML = '';
        Object.assign(container.style, { position: 'relative', overflow: 'hidden', background: '#000' });
        this.canvas = document.createElement('canvas');
        Object.assign(this.canvas.style, { display: 'block', margin: '0 auto', cursor: 'default' });
        this.cursor = null;
        this.cursorOverride = null;
        this._cursorRaster = null;
        container.appendChild(this.canvas);
        this.ownsAssets = !assetManager;
        this.assetManager = assetManager || new AssetManager();
        if (this.ownsAssets) this.assetManager.onAssetReady = onAssetReady;
        this.renderer = new Renderer(this.canvas, this.assetManager);
        this.inputHandler = new InputHandler(this.canvas, send,
            () => this.renderer.thingIndices, this.assetManager, gamepad);
        this.inputHandler.attach();
    }

    // Cursor selection belongs to the session/player, independently of hover.
    // Keep the requested asset key when bytes have not arrived yet, so the
    // session's asset-ready callback can refresh this view later.
    setCursor(cursor) {
        if (this.destroyed) return;
        if (this.cursor?.assetKey !== cursor?.assetKey
            || this.cursor?.size?.width !== cursor?.size?.width
            || this.cursor?.size?.height !== cursor?.size?.height) this._cursorRaster = null;
        this.cursor = cursor && { assetKey: cursor.assetKey, hotspot: { ...cursor.hotspot },
            ...(cursor.size ? { size: { ...cursor.size } } : {}) };
        this.refreshCursor();
    }

    // Internal UI override used by the Studio picker without changing the
    // game's selection. Clearing it restores the current session cursor.
    setCursorOverride(value) {
        if (this.destroyed) return;
        this.cursorOverride = value;
        this.refreshCursor();
    }

    refreshCursor() {
        if (this.destroyed) return;
        // Image loading can notify readiness synchronously. Finish the current
        // lookup, then refresh again rather than letting the outer call undo
        // the ready image selected by a nested callback.
        if (this._refreshingCursor) { this._cursorRefreshPending = true; return; }
        this._refreshingCursor = true;
        try {
            do {
                this._cursorRefreshPending = false;
                let value = this.cursorOverride || 'default';
                const asset = this.cursor && this.assetManager.assets[this.cursor.assetKey];
                if (this._cursorRaster?.data !== asset?.data) this._cursorRaster = null;
                if (!this.cursorOverride && asset?.type === 'image' && typeof asset.data === 'string') {
                    const url = this._cursorImageUrl(asset);
                    if (url) {
                        const { x, y } = this.cursor.hotspot;
                        value = `url("${url}") ${x} ${y}, default`;
                    }
                }
                if (this.canvas.style.cursor !== value) this.canvas.style.cursor = value;
            } while (this._cursorRefreshPending && !this.destroyed);
        } finally {
            this._refreshingCursor = false;
        }
    }

    _cursorImageUrl(asset) {
        if (!this.cursor.size) return asset.data;
        const image = this.assetManager.getImage(this.cursor.assetKey);
        if (!image) return null;
        const { width, height } = this.cursor.size;
        const cached = this._cursorRaster;
        if (cached?.data === asset.data && cached.image === image
            && cached.width === width && cached.height === height) return cached.url;
        // Only a game-requested size causes rasterization. Hotspots are already
        // expressed in these output pixels and are never adjusted by the view.
        const raster = this._cursorRaster = { data: asset.data, image, width, height, url: null };
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(image, 0, 0, width, height);
            raster.url = canvas.toDataURL('image/png');
        } catch (_) { /* Keep the native default if the image cannot be rasterized. */ }
        return raster.url;
    }

    resize(aspectRatio) {
        const maxWidth = this.container.clientWidth || window.innerWidth;
        const maxHeight = this.container.clientHeight || window.innerHeight;
        const fitHeight = maxWidth * aspectRatio.y / aspectRatio.x <= maxHeight;
        const width = fitHeight ? maxWidth : Math.floor(maxHeight * aspectRatio.x / aspectRatio.y);
        const height = fitHeight ? Math.floor(maxWidth * aspectRatio.y / aspectRatio.x) : maxHeight;
        this.canvas.width = width * 2;
        this.canvas.height = height * 2;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
        this.inputHandler.clientWidth = width;
        this.inputHandler.clientHeight = height;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cursor = null;
        this.cursorOverride = null;
        this._cursorRaster = null;
        this.canvas.style.cursor = 'default';
        this.inputHandler.detach();
        this.renderer.stopAllSounds();
        if (this.ownsAssets) {
            this.assetManager.onAssetReady = null;
            this.assetManager.destroy();
        }
        this.canvas.remove();
    }
}

// Exactly one scheduled callback per running view group, including redirects
// and reentrant stop calls from game input. Studio's extra players share it.
class FrameLoop {
    constructor(paint) { this.paint = paint; this.running = false; this.id = null; }
    start() {
        if (this.running) return;
        this.running = true;
        this.tick();
    }
    tick() {
        this.id = null;
        if (!this.running) return;
        this.paint();
        if (this.running) this.id = requestAnimationFrame(() => this.tick());
    }
    stop() {
        this.running = false;
        if (this.id !== null) cancelAnimationFrame(this.id);
        this.id = null;
    }
}

const getClientInfo = () => {
    const ua = navigator.userAgent;
    let deviceType = 'desktop';
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) deviceType = 'tablet';
    else if (/Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) deviceType = 'mobile';
    else if (navigator.maxTouchPoints > 2) deviceType = 'tablet';
    const info = { deviceType };
    if (window.innerWidth && window.innerHeight) info.aspectRatio = window.innerWidth / window.innerHeight;
    return info;
};

module.exports = { GameView, FrameLoop, getClientInfo };
