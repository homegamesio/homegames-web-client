/**
 * image-fit — standalone browser image resizer with no dependencies on the
 * rest of the client. Given a Blob/File and a byte budget, returns bytes
 * guaranteed (best-effort) to fit the budget by re-encoding through a canvas:
 * first lowering encode quality, then scaling down dimensions.
 *
 *   const { blob, contentType, fileName } = await fitImageToSize(file, 5 * 1024 * 1024);
 *
 * Files already under the budget pass through untouched. Output format:
 * JPEG and WebP inputs keep their format; everything else (PNG, GIF, BMP,
 * ...) re-encodes to WebP (alpha-preserving) or JPEG where the browser
 * can't encode WebP. Animated GIFs survive only as their first frame —
 * canvas decoding has no access to the other frames.
 *
 * Rejects when the blob can't be decoded as an image (corrupt file, audio,
 * unsupported format) or when even a heavily-degraded encode won't fit.
 */

// Formats canvas.toBlob can encode with an adjustable quality knob.
const QUALITY_TYPES = ['image/jpeg', 'image/webp'];

const MAX_ATTEMPTS = 10;
// Never scale a dimension below this; a legible image beats a fitting one
// of 3 pixels, and the byte floor is reached long before this anyway.
const MIN_DIMENSION = 16;

// canvas.toBlob falls back to PNG for encoder types the browser doesn't
// support (per spec), so support is detected from the resulting blob type.
let webpSupport = null;
const canEncodeWebp = async () => {
    if (webpSupport !== null) return webpSupport;
    const blob = await encodeCanvas(createCanvas(1, 1), 'image/webp', 0.8).catch(() => null);
    webpSupport = !!blob && blob.type === 'image/webp';
    return webpSupport;
};

const createCanvas = (width, height) => {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};

const encodeCanvas = (canvas, type, quality) => {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas encoding failed'));
        }, type, quality);
    });
};

// Decode into something drawable + its pixel dimensions. createImageBitmap
// handles more formats off the main thread; <img> is the fallback for
// browsers (older Safari) that lack it or fail on a given blob.
const decodeImage = async (blob) => {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close && bitmap.close() };
        } catch (e) { /* fall through to <img> */ }
    }
    if (typeof document === 'undefined') throw new Error('Not decodable as an image');
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Not decodable as an image'));
        };
        img.src = url;
    });
};

// Swap the extension to match a changed encode format so the name doesn't
// lie about the bytes (the platform sniffs bytes anyway; this is cosmetic).
const renameForType = (fileName, type) => {
    if (!fileName) return fileName;
    const ext = type === 'image/webp' ? '.webp' : '.jpg';
    const dot = fileName.lastIndexOf('.');
    return (dot > 0 ? fileName.slice(0, dot) : fileName) + ext;
};

const drawScaled = (decoded, scale, fillBackground) => {
    const width = Math.max(MIN_DIMENSION, Math.round(decoded.width * scale));
    const height = Math.max(MIN_DIMENSION, Math.round(decoded.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (fillBackground) {
        // JPEG has no alpha channel; transparent pixels otherwise land black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return canvas;
};

/**
 * Fit an image blob into maxBytes.
 *
 * @param {Blob} blob — the image (a File works; .type/.name are used if present)
 * @param {number} maxBytes — byte budget the result must fit
 * @param {object} [opts]
 * @param {string} [opts.fileName] — overrides blob.name for the returned fileName
 * @returns {Promise<{blob: Blob, contentType: string|null, fileName: string|null, resized: boolean}>}
 * @throws when the blob isn't a decodable image or can't be fit into budget
 */
const fitImageToSize = async (blob, maxBytes, opts = {}) => {
    if (!blob || typeof blob.size !== 'number') throw new Error('Expected a Blob or File');
    if (!(maxBytes > 0)) throw new Error('maxBytes must be a positive number');

    const fileName = opts.fileName || blob.name || null;
    const contentType = blob.type || null;

    if (blob.size <= maxBytes) {
        return { blob, contentType, fileName, resized: false };
    }

    const decoded = await decodeImage(blob);
    try {
        const keepType = QUALITY_TYPES.indexOf(contentType) !== -1;
        const outType = keepType ? contentType
            : (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';

        let quality = 0.85;
        let scale = 1;
        let best = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const canvas = drawScaled(decoded, scale, outType === 'image/jpeg');
            const encoded = await encodeCanvas(canvas, outType, quality);
            if (!best || encoded.size < best.size) best = encoded;
            if (encoded.size <= maxBytes) break;

            if (quality > 0.6) {
                // Cheaper first: quality costs bytes superlinearly and no pixels.
                quality = Math.max(0.6, quality - 0.15);
            } else {
                // Bytes track pixel count ~linearly at fixed quality, so jump
                // straight toward the budget (0.9 undershoot for safety).
                const atFloor = Math.min(decoded.width, decoded.height) * scale <= MIN_DIMENSION;
                if (atFloor) break;
                scale *= Math.max(0.3, Math.sqrt(maxBytes / encoded.size) * 0.9);
            }
        }

        if (!best || best.size > maxBytes) {
            throw new Error(`Could not fit image into ${maxBytes} bytes`);
        }

        return {
            blob: best,
            contentType: outType,
            fileName: keepType ? fileName : renameForType(fileName, outType),
            resized: true
        };
    } finally {
        decoded.close();
    }
};

module.exports = { fitImageToSize };
