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
        Object.assign(this.canvas.style, { display: 'block', margin: '0 auto' });
        container.appendChild(this.canvas);
        this.ownsAssets = !assetManager;
        this.assetManager = assetManager || new AssetManager();
        if (this.ownsAssets) this.assetManager.onAssetReady = onAssetReady;
        this.renderer = new Renderer(this.canvas, this.assetManager);
        this.inputHandler = new InputHandler(this.canvas, send,
            () => this.renderer.thingIndices, this.assetManager, gamepad);
        this.inputHandler.attach();
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
