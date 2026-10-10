const { createSessionRuntime } = require('homegames-common/session-runtime');

// The browser receives asset bytes in its preload bundle or through addAsset.
// Squish still needs the asset references for per-player audio filtering, but
// its Node-based Asset.getData() download/cache path must never run here.
module.exports = (Squisher, game, options = {}) => {
    class BrowserSquisher extends Squisher {
        initialize() {
            const metadata = this.game.constructor.metadata?.();
            this.gameAssets = Object.assign({}, metadata?.assets,
                this.customBottomLayer?.assets, this.customTopLayer?.assets,
                this.game.getAssets?.());
            this.assetBundle = new Uint8Array(0);
            return Promise.resolve(this.assetBundle);
        }
    }
    return createSessionRuntime(BrowserSquisher, game, options);
};
