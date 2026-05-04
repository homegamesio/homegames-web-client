/**
 * Asset storage and decoding — handles image, audio, and font assets
 * received as binary frames from the game server.
 */

class AssetManager {
    constructor() {
        this.assets = {};       // key -> { type, data, decoded }
        this.imageCache = {};   // key -> Image element or 'loading'
        this.audioCtx = null;
    }

    /**
     * Ensure AudioContext is created and resumed.
     * Must be called from a user gesture handler (click/touch) on iOS/Safari.
     */
    unlockAudio() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        // Decode any audio assets that were received before AudioContext was created
        for (const key in this.assets) {
            if (this.assets[key].type === 'audio' && !this.assets[key].decoded) {
                this.audioCtx.decodeAudioData(this.assets[key].data, (buffer) => {
                    this.assets[key].data = buffer;
                    this.assets[key].decoded = true;
                });
            }
        }
    }

    /**
     * Parse a binary asset bundle (frame type 1) and store the assets.
     */
    storeAssets(buf) {
        let i = 0;

        while (buf && i < buf.length) {
            const frameType = buf[i];

            if (frameType !== 1) break;

            const assetType = buf[i + 1];
            const payloadLengthBase32 = String.fromCharCode.apply(null, buf.slice(i + 2, i + 12));
            const payloadLength = parseInt(payloadLengthBase32, 36);
            const payloadKeyRaw = buf.slice(i + 12, i + 12 + 32);
            const payloadKey = String.fromCharCode.apply(null, payloadKeyRaw.filter(k => k));
            const payloadData = buf.slice(i + 12 + 32, i + 12 + payloadLength);

            if (assetType === 1) {
                // Image
                let imgBase64String = '';
                for (let j = 0; j < payloadData.length; j++) {
                    imgBase64String += String.fromCharCode(payloadData[j]);
                }
                const imgBase64 = btoa(imgBase64String);
                this.assets[payloadKey] = { type: 'image', data: 'data:image/jpeg;base64,' + imgBase64 };

            } else if (assetType === 2) {
                // Audio
                if (this.audioCtx) {
                    this.audioCtx.decodeAudioData(payloadData.buffer, (buffer) => {
                        this.assets[payloadKey] = { type: 'audio', data: buffer, decoded: true };
                    }, (err) => {
                        console.warn('Unable to decode audio:', err);
                    });
                } else {
                    this.assets[payloadKey] = { type: 'audio', data: payloadData.buffer, decoded: false };
                }

            } else if (assetType === 3) {
                // Font
                const font = new FontFace(payloadKey, payloadData);
                if (font) {
                    font.load().then((loadedFont) => {
                        document.fonts.add(loadedFont);
                        this.assets[payloadKey] = { type: 'font', data: loadedFont, name: payloadKey };
                    });
                }
            }

            i += 12 + payloadLength;
        }
    }

    /**
     * Get a cached Image element for the given asset key.
     * Returns the Image if ready, starts loading if not, returns null if unknown.
     */
    getImage(assetKey) {
        if (this.imageCache[assetKey] && this.imageCache[assetKey] !== 'loading') {
            return this.imageCache[assetKey];
        }

        if (!this.imageCache[assetKey] && this.assets[assetKey] && this.assets[assetKey].type === 'image') {
            const image = new Image();
            this.imageCache[assetKey] = 'loading';
            image.onload = () => {
                this.imageCache[assetKey] = image;
            };
            image.src = this.assets[assetKey].data;
        }

        return null;
    }

    destroy() {
        if (this.audioCtx) {
            this.audioCtx.close().catch(() => {});
            this.audioCtx = null;
        }
        this.assets = {};
        this.imageCache = {};
    }
}

module.exports = AssetManager;
