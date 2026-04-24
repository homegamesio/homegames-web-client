/**
 * Canvas renderer — takes unsquished game frames and draws them to a <canvas>.
 *
 * Handles: polygons, text, images, audio playback, effects (shadows).
 * Returns hit-test data for the input handler.
 */

class Renderer {
    constructor(canvas, assetManager) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.assetManager = assetManager;
        this.playingSounds = {};
        this.thingIndices = [];  // click hit-test data from last frame
    }

    /**
     * Render a full frame buffer.
     * @param {Uint8ClampedArray} buf - Raw binary frame (type 3)
     * @param {function} unsquish - The unsquish function for the current squish version
     */
    renderFrame(buf, unsquish) {
        const { canvas, ctx, assetManager } = this;
        const soundsToStop = new Set(Object.keys(this.playingSounds));
        const seenSoundAssets = new Set();

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
                    [textStartX, thing.text.y, textStartX + textWidthPercent, thing.text.y, textStartX + textWidthPercent, thing.text.y + textHeightPercent, textStartX, thing.text.y + textHeightPercent, textStartX, thing.text.y]
                ]);
            } else if (thing.coordinates2d !== null && thing.coordinates2d !== undefined) {
                this.thingIndices.push([
                    !!thing.handleClick,
                    thing.input && thing.input.type,
                    thing.id,
                    thing.coordinates2d
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
                const assetData = assetManager.assets[assetKey];

                if (assetData && assetData.type === 'audio') {
                    seenSoundAssets.add(assetKey);
                    if (!this.playingSounds[assetKey] && assetManager.audioCtx && assetData.decoded) {
                        const source = assetManager.audioCtx.createBufferSource();
                        source.connect(assetManager.audioCtx.destination);
                        source.buffer = assetData.data;
                        source.start(0, thing.asset[assetKey].startTime || 0);
                        this.playingSounds[assetKey] = source;
                    } else if (this.playingSounds[assetKey]) {
                        soundsToStop.delete(assetKey);
                    }
                } else if (assetData && assetData.type !== 'audio') {
                    const asset = thing.asset[assetKey];
                    const image = assetManager.getImage(assetKey);
                    if (image) {
                        image.width = asset.size.x / 100 * canvas.width;
                        image.height = asset.size.y / 100 * canvas.height;
                        if (thing.effects && thing.effects.shadow) {
                            const sc = thing.effects.shadow.color;
                            ctx.shadowColor = 'rgba(' + sc[0] + ',' + sc[1] + ',' + sc[2] + ',' + sc[3] + ')';
                            if (thing.effects.shadow.blur) ctx.shadowBlur = thing.effects.shadow.blur;
                        }
                        ctx.drawImage(image, (asset.pos.x / 100) * canvas.width, (asset.pos.y / 100) * canvas.height, image.width, image.height);
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

        // Stop sounds that are no longer referenced
        for (const k in this.playingSounds) {
            if (!seenSoundAssets.has(k)) {
                try { this.playingSounds[k].stop(); } catch (e) {}
                delete this.playingSounds[k];
            }
        }
    }

    stopAllSounds() {
        for (const k in this.playingSounds) {
            try { this.playingSounds[k].stop(); } catch (e) {}
        }
        this.playingSounds = {};
    }
}

module.exports = Renderer;
