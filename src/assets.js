/**
 * Asset storage and decoding — handles image, audio, and font assets
 * received as binary frames from the game server.
 */
const { describeMedia } = require('homegames-common/media-upload');

// Bytes -> binary string in chunks (String.fromCharCode.apply is limited by
// max argument count; MB-sized images would blow the call stack).
const bytesToBinaryString = (bytes) => {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.slice(i, i + CHUNK));
    }
    return binary;
};

// Detect the actual image format from magic bytes instead of assuming JPEG.
const sniffImageMime = (bytes) => {
    if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes.length > 2 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length > 11 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    // SVG has no binary signature. Recognize its root (optionally after an
    // XML declaration) so generated game images decode with their real MIME.
    const prefix = bytesToBinaryString(bytes.subarray(0, 1024)).replace(/^\xEF\xBB\xBF/, '');
    if (/^\s*(?:<\?xml\b[^?]*\?>\s*)?<svg\b/i.test(prefix)) return 'image/svg+xml';
    return 'image/jpeg';
};

class AssetManager {
    constructor() {
        this.assets = {};       // key -> { type, data, decoded }
        this.imageCache = {};   // key -> Image element or 'loading'
        this.audioCtx = null;
        this.mediaPlayers = new Set();
        this.mediaUnlocked = false;
        // Optional callback invoked when an asset finishes loading
        // asynchronously (image decode, font load, audio decode). The client
        // uses this to repaint the current frame — otherwise a frame that
        // referenced a not-yet-loaded asset would render empty and stay that
        // way until the next state update arrives.
        this.onAssetReady = null;
    }

    _notifyReady() {
        if (typeof this.onAssetReady === 'function') this.onAssetReady();
    }

    /**
     * Ensure AudioContext is created and resumed.
     * Must be called from a user gesture handler (click/touch) on iOS/Safari.
     */
    unlockAudio() {
        this.mediaUnlocked = true;
        for (const player of this.mediaPlayers) player.unlock();
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        // Decode any audio assets that were received before AudioContext was created
        for (const key in this.assets) {
            const asset = this.assets[key];
            if (asset.type === 'audio' && !asset.decoded && !asset.decoding) {
                asset.decoding = true;
                const failed = err => {
                    asset.decoding = false;
                    console.warn('Unable to decode audio:', err);
                };
                try {
                    // Decoding detaches its input. Keep the retained bytes intact
                    // for retries and the session's later RTC asset transfers.
                    this.audioCtx.decodeAudioData(asset.data.slice(0), buffer => {
                        if (this.assets[key] !== asset) return;
                        asset.data = buffer;
                        asset.decoded = true;
                        asset.decoding = false;
                        this._notifyReady();
                    }, failed);
                } catch (err) { failed(err); }
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
            // A corrupt length header would otherwise stall or loop the parse.
            if (!Number.isFinite(payloadLength) || payloadLength <= 0) break;
            const payloadKeyRaw = buf.slice(i + 12, i + 12 + 32);
            const payloadKey = String.fromCharCode.apply(null, payloadKeyRaw.filter(k => k));
            const payloadData = buf.slice(i + 12 + 32, i + 12 + payloadLength);

            const typeName = assetType === 1 ? 'image' : assetType === 2 ? 'audio' : assetType === 3 ? 'font' : assetType === 4 ? 'video' : null;
            if (typeName) {
                this.storeRawAsset(payloadKey, typeName, payloadData);
            }

            i += 12 + payloadLength;
        }
    }

    /**
     * Store one asset from raw bytes. Used both by the bundle parser above and
     * by LocalSession's addAsset (player uploads in serverless local play).
     */
    storeRawAsset(key, type, data) {
        const bytes = data instanceof Uint8Array || data instanceof Uint8ClampedArray
            ? data
            : Uint8Array.from(data);
        const previous = this.assets[key];
        if (previous?.url) URL.revokeObjectURL(previous.url);

        if (type === 'image') {
            const mime = describeMedia(bytes).contentType || sniffImageMime(bytes);
            this.assets[key] = { type: 'image', data: `data:${mime};base64,` + btoa(bytesToBinaryString(bytes)) };
            // If the key is reused (e.g. re-upload), drop the stale decode.
            delete this.imageCache[key];
            this._notifyReady();

        } else if (type === 'audio') {
            if (this.audioCtx) {
                try {
                    this.audioCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), (buffer) => {
                        this.assets[key] = { type: 'audio', data: buffer, decoded: true };
                        this._notifyReady();
                    }, (err) => {
                        console.warn('Unable to decode audio:', err);
                    });
                } catch (err) {
                    console.warn('Unable to decode audio:', err);
                }
            } else {
                this.assets[key] = { type: 'audio', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), decoded: false };
            }

        } else if (type === 'video') {
            const media = describeMedia(bytes);
            this.assets[key] = { type: 'video', data: new Blob([bytes], { type: media.contentType || 'video/mp4' }), url: null };
            this._notifyReady();
        } else if (type === 'font') {
            try {
                const font = new FontFace(key, bytes);
                font.load().then((loadedFont) => {
                    document.fonts.add(loadedFont);
                    this.assets[key] = { type: 'font', data: loadedFont, name: key };
                    this._notifyReady();
                }).catch((err) => {
                    console.warn('Unable to load font:', err);
                });
            } catch (err) {
                console.warn('Unable to load font:', err);
            }
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
            const asset = this.assets[assetKey];
            const image = new Image();
            this.imageCache[assetKey] = 'loading';
            image.onload = () => {
                if (this.assets[assetKey] !== asset) return;
                this.imageCache[assetKey] = image;
                this._notifyReady();
            };
            image.src = asset.data;
        }

        return null;
    }

    destroy() {
        this.liveMedia?.destroy();
        for (const player of [...this.mediaPlayers]) player.destroy();
        for (const asset of Object.values(this.assets)) if (asset.url) URL.revokeObjectURL(asset.url);
        if (this.audioCtx) {
            this.audioCtx.close().catch(() => {});
            this.audioCtx = null;
        }
        this.assets = {};
        this.imageCache = {};
    }
}

module.exports = AssetManager;
