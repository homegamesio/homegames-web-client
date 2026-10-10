/**
 * Canvas renderer — takes unsquished game frames and draws them to a <canvas>.
 *
 * Handles: polygons, text, images, audio playback, effects (shadows).
 * Returns hit-test data for the input handler.
 */

const VideoPlayer = require('./video-player');
const { readStreamKey } = require('homegames-common/stream-node');

class Renderer {
    constructor(canvas, assetManager) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.assetManager = assetManager;
        this.playingSounds = {};
        this.videos = new Map();
        this.mediaDirty = false;
        this.thingIndices = [];  // click hit-test data from last frame
    }

    /**
     * Render a full frame buffer.
     * @param {Uint8ClampedArray} buf - Raw binary frame (type 3)
     * @param {function} unsquish - The unsquish function for the current squish version
     * @param {object} [opts]
     * @param {boolean} [opts.muteAudio] - Skip starting audio and stop anything
     *        playing (used when rendering recorded frames in the inspector)
     */
    renderFrame(buf, unsquish, opts = {}) {
        const { canvas, ctx, assetManager } = this;
        const soundsToStop = new Set(Object.keys(this.playingSounds));
        const seenSoundAssets = new Set();
        const seenVideos = new Set();
        this.mediaDirty = false;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.thingIndices = [];

        let i = 0;

        while (buf && i < buf.length) {
            const frameType = buf[i];
            const frameSize = buf[i + 1] + buf[i + 2] + buf[i + 3];

            let thing;
            try {
                thing = unsquish(buf.slice(i, i + frameSize)).node;
            } catch (e) {
                i += frameSize;
                continue;
            }

            // --- Hit-test index ---
            if (!thing.coordinates2d && thing.input && thing.text) {
                const maxTextSize = Math.floor(canvas.width);
                const fontSize = (thing.text.size / 100) * maxTextSize;
                ctx.font = fontSize + 'px sans-serif';
                const textInfo = ctx.measureText(thing.text.text);
                let textStartX = thing.text.x * canvas.width / 100;
                if (thing.text.align && thing.text.align === 'center') {
                    textStartX -= textInfo.width / 2;
                }
                textStartX = textStartX / canvas.width * 100;
                const textHeight = textInfo.actualBoundingBoxDescent - textInfo.actualBoundingBoxAscent;
                const textWidthPercent = textInfo.width / canvas.width * 100;
                const textHeightPercent = textHeight / canvas.height * 100;

                this.thingIndices.push([
                    !!thing.handleClick,
                    thing.input && thing.input.type,
                    thing.id,
                    [textStartX, thing.text.y, textStartX + textWidthPercent, thing.text.y, textStartX + textWidthPercent, thing.text.y + textHeightPercent, textStartX, thing.text.y + textHeightPercent, textStartX, thing.text.y],
                    !!thing.onHover
                ]);
            } else if (thing.coordinates2d !== null && thing.coordinates2d !== undefined) {
                this.thingIndices.push([
                    !!thing.handleClick,
                    thing.input && thing.input.type,
                    thing.id,
                    thing.coordinates2d,
                    !!thing.onHover
                ]);

                // --- Effects ---
                if (thing.effects && thing.effects.shadow) {
                    const sc = thing.effects.shadow.color;
                    ctx.shadowColor = 'rgba(' + sc[0] + ',' + sc[1] + ',' + sc[2] + ',' + sc[3] + ')';
                    if (thing.effects.shadow.blur) ctx.shadowBlur = thing.effects.shadow.blur;
                }

                if (thing.color) ctx.globalAlpha = thing.color[3] / 255;

                if (thing.fill !== null && thing.fill !== undefined) {
                    ctx.fillStyle = 'rgba(' + thing.fill[0] + ',' + thing.fill[1] + ',' + thing.fill[2] + ',' + thing.fill[3] + ')';
                }

                if (thing.border !== undefined && thing.border !== null) {
                    ctx.lineWidth = (thing.border / 255) * 0.1 * canvas.width;
                    ctx.strokeStyle = 'rgba(' + thing.color[0] + ',' + thing.color[1] + ',' + thing.color[2] + ',' + thing.color[3] + ')';
                }

                // --- Draw polygon ---
                ctx.beginPath();
                const firstPoint = thing.coordinates2d[0];
                ctx.moveTo(firstPoint[0] * canvas.width / 100, firstPoint[1] * canvas.height / 100);
                for (let j = 1; j < thing.coordinates2d.length; j++) {
                    const pt = thing.coordinates2d[j];
                    ctx.lineTo(pt[0] * canvas.width / 100, pt[1] * canvas.height / 100);
                }
                if (thing.fill !== undefined && thing.fill !== null) ctx.fill();
                if (thing.border !== undefined && thing.border !== null) ctx.stroke();

                ctx.shadowColor = null;
                ctx.shadowBlur = 0;
                ctx.lineWidth = 0;
                ctx.strokeStyle = null;
            }

            // --- Text ---
            if (thing.text) {
                ctx.globalAlpha = thing.text.color[3] / 255;
                ctx.fillStyle = 'rgba(' + thing.text.color[0] + ',' + thing.text.color[1] + ',' + thing.text.color[2] + ',' + thing.text.color[3] + ')';
                const maxTextSize = Math.floor(canvas.width);
                const fontSize = (thing.text.size / 100) * maxTextSize;
                const fontFamily = (!thing.text.font || thing.text.font === 'default') ? 'sans-serif' : thing.text.font;
                ctx.font = fontSize + 'px ' + fontFamily;
                if (thing.text.align) ctx.textAlign = thing.text.align;
                ctx.textBaseline = 'top';
                ctx.fillText(thing.text.text, thing.text.x * canvas.width / 100, thing.text.y * canvas.height / 100);
            }

            // --- Assets (images + audio) ---
            if (thing.asset) {
                const assetKey = Object.keys(thing.asset)[0];
                const stream = readStreamKey(assetKey);
                const assetData = stream ? assetManager.liveMedia?.streams.get(stream.id) : assetManager.assets[assetKey];

                if (assetData && assetData.type === 'audio') {
                    const soundId = `${thing.id}:${assetKey}`;
                    if (!opts.muteAudio) {
                        seenSoundAssets.add(soundId);
                        if (!this.playingSounds[soundId] && assetManager.audioCtx && assetData.decoded) {
                            const source = assetManager.audioCtx.createBufferSource();
                            source.connect(assetManager.audioCtx.destination);
                            source.buffer = assetData.data;
                            source.start(0, thing.asset[assetKey].startTime || 0);
                            this.playingSounds[soundId] = source;
                        } else if (this.playingSounds[soundId]) {
                            soundsToStop.delete(soundId);
                        }
                    }
                } else if (assetData && (assetData.type === 'image' || assetData.type === 'video' || (stream && assetData.data))) {
                    const asset = thing.asset[assetKey];
                    let image;
                    if (assetData.type === 'video' || stream) {
                        const id = `${thing.id}:${assetKey}`;
                        seenVideos.add(id);
                        let player = this.videos.get(id);
                        if (player && player.asset !== assetData) { player.destroy(); player = null; }
                        const mediaOpts = { ...opts, muteAudio: !!opts.muteAudio || !!(stream && (!stream.audio || assetData.local || !assetData.transmitting)) };
                        if (!player) {
                            player = new VideoPlayer(assetManager, assetData, asset.startTime || 0, () => { this.mediaDirty = true; }, mediaOpts);
                            this.videos.set(id, player);
                        }
                        player.update(mediaOpts.muteAudio, !!opts.freezeMedia);
                        image = (!stream || assetData.video) && !player.error && player.element.readyState >= 2 ? player.element : null;
                        if (!image && (!stream || assetData.video)) {
                            const x = asset.pos.x / 100 * canvas.width, y = asset.pos.y / 100 * canvas.height;
                            ctx.fillStyle = '#202226'; ctx.fillRect(x, y, asset.size.x / 100 * canvas.width, asset.size.y / 100 * canvas.height);
                            ctx.fillStyle = '#fff'; ctx.font = `${Math.max(12, canvas.width * .015)}px sans-serif`;
                            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                            ctx.fillText(player.error ? 'Video format not supported' : 'Loading video…', x + asset.size.x / 200 * canvas.width, y + asset.size.y / 200 * canvas.height);
                        }
                    } else image = assetManager.getImage(assetKey);
                    if (image) {
                        image.width = asset.size.x / 100 * canvas.width;
                        image.height = asset.size.y / 100 * canvas.height;
                        if (thing.effects && thing.effects.shadow) {
                            const sc = thing.effects.shadow.color;
                            ctx.shadowColor = 'rgba(' + sc[0] + ',' + sc[1] + ',' + sc[2] + ',' + sc[3] + ')';
                            if (thing.effects.shadow.blur) ctx.shadowBlur = thing.effects.shadow.blur;
                        }

                        const dx = (asset.pos.x / 100) * canvas.width;
                        const dy = (asset.pos.y / 100) * canvas.height;

                        // Crop: percentages (0-100) of the source image removed
                        // from each edge. Absent on nodes from older squish
                        // versions, so default to 0 (no crop).
                        let cropLeft = asset.cropLeft || 0;
                        let cropTop = asset.cropTop || 0;
                        let cropRight = asset.cropRight || 0;
                        let cropBottom = asset.cropBottom || 0;

                        // A source rect with zero/negative width or height makes
                        // drawImage throw — ignore insets that would collapse it.
                        if (cropLeft + cropRight >= 100) { cropLeft = 0; cropRight = 0; }
                        if (cropTop + cropBottom >= 100) { cropTop = 0; cropBottom = 0; }

                        if (cropLeft || cropTop || cropRight || cropBottom) {
                            // Source sub-rectangle in the image's natural pixel
                            // space. naturalWidth/Height are the true decoded
                            // dimensions (image.width/height above were mutated
                            // to destination size).
                            let sx = (cropLeft / 100) * (image.videoWidth || image.naturalWidth);
                            let sy = (cropTop / 100) * (image.videoHeight || image.naturalHeight);
                            let sWidth = (1 - (cropLeft + cropRight) / 100) * (image.videoWidth || image.naturalWidth);
                            let sHeight = (1 - (cropTop + cropBottom) / 100) * (image.videoHeight || image.naturalHeight);
                            // Clamp the source rect into the image's real pixel
                            // bounds. Crop values arrive with 2-decimal wire
                            // precision, so the computed rect can poke slightly
                            // past the edge — and WebKit edge-extends samples
                            // outside the image instead of clipping, smearing
                            // the last row/column across the overflow.
                            sx = Math.max(0, Math.min(sx, (image.videoWidth || image.naturalWidth) - 1));
                            sy = Math.max(0, Math.min(sy, (image.videoHeight || image.naturalHeight) - 1));
                            sWidth = Math.min(sWidth, (image.videoWidth || image.naturalWidth) - sx);
                            sHeight = Math.min(sHeight, (image.videoHeight || image.naturalHeight) - sy);
                            if (sWidth >= 1 && sHeight >= 1) {
                                ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, image.width, image.height);
                            }
                        } else {
                            ctx.drawImage(image, dx, dy, image.width, image.height);
                        }
                    }
                }
            }

            i += frameSize;
            ctx.shadowColor = null;
            ctx.shadowBlur = 0;
            ctx.lineWidth = 0;
            ctx.strokeStyle = null;
            ctx.globalAlpha = 1;
        }

        for (const [id, player] of this.videos) {
            if (!seenVideos.has(id)) { player.destroy(); this.videos.delete(id); }
        }

        // Stop sounds that are no longer referenced
        for (const k in this.playingSounds) {
            if (!seenSoundAssets.has(k)) {
                try { this.playingSounds[k].stop(); } catch (e) {}
                delete this.playingSounds[k];
            }
        }
    }

    needsRepaint() {
        return this.mediaDirty || [...this.videos.values()].some(player => player.needsRepaint());
    }

    stopAllSounds() {
        for (const player of this.videos.values()) player.destroy();
        this.videos.clear(); this.mediaDirty = false;
        for (const k in this.playingSounds) {
            try { this.playingSounds[k].stop(); } catch (e) {}
        }
        this.playingSounds = {};
    }
}

module.exports = Renderer;
