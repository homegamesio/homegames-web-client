/**
 * Browser-safe builder for the type-1 asset bundle format — byte-identical
 * to squish's Squisher.initialize() packing (and to the platform API's
 * local-play packer): per asset a 44-byte header
 * [1, typeByte, 10-byte base36 length of (data+32), 32-byte key] + data.
 *
 * Lets in-browser consumers (e.g. the Studio's local preview) assemble a
 * bundle from individually fetched asset bytes and hand it to a LocalSession.
 */

const ASSET_TYPE_BYTES = { image: 1, audio: 2, font: 3 };

/**
 * @param {Array<{key: string, type: string, data: Uint8Array}>} entries
 * @returns {Uint8Array}
 */
const packAssetBundle = (entries) => {
    const parts = entries.map(({ key, type, data }) => {
        const assetKeyLength = 32;
        const encodedMaxLength = 10;
        const headerLength = 2 + encodedMaxLength + assetKeyLength;
        const buf = new Uint8Array(headerLength + data.length);

        buf[0] = 1;
        buf[1] = ASSET_TYPE_BYTES[type] || ASSET_TYPE_BYTES.image;

        const encodedLength = (data.length + assetKeyLength).toString(36);
        const padLen = encodedMaxLength - encodedLength.length;
        for (let i = 0; i < padLen; i++) {
            buf[2 + i] = 48; // '0'
        }
        for (let i = 0; i < encodedLength.length; i++) {
            buf[2 + padLen + i] = encodedLength.charCodeAt(i);
        }

        const keyWriteLen = Math.min(assetKeyLength, key.length);
        for (let i = 0; i < keyWriteLen; i++) {
            buf[2 + encodedMaxLength + i] = key.charCodeAt(i);
        }

        buf.set(data, headerLength);
        return buf;
    });

    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

module.exports = { packAssetBundle };
