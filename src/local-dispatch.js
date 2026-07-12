/**
 * LocalDispatcher — routes input protocol messages directly into a game
 * instance, for sessions that run entirely in the browser with no server.
 *
 * This is a faithful port of the server's input semantics
 * (homegames-common/game-session.js: handleInput, _handleClick, _findClick,
 * _findClickHelper) with the frame/bezel and spectator paths removed (local
 * sessions are frameless, scale 1). A game must not be able to tell whether
 * it is running locally or in a hosted session, so any behavior change to
 * the server's input handling must be mirrored here. In particular:
 *   - a click resolves to the topmost node CONTAINING the point (whether or
 *     not it has a click handler), honoring playerIds visibility, and is
 *     silently dropped when that node has no handleClick
 *   - keys are capped at 20 chars, malformed messages are ignored, and a
 *     handler throwing never takes down the session
 */

// File uploads arrive as base64 (see InputHandler._promptFileUpload); older
// clients sent a JSON-ified Uint8Array ({"0":137,...}). Decode either into
// the plain byte array games expect. Mirrors game-session.js _decodeFileInput.
const MAX_FILE_INPUT_BYTES = 8 * 1024 * 1024;

const decodeFileInput = (raw) => {
    if (typeof raw === 'string') {
        let binary;
        if (typeof atob === 'function') {
            binary = atob(raw);
            if (binary.length === 0 || binary.length > MAX_FILE_INPUT_BYTES) return null;
            const bytes = new Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === 0 || buf.length > MAX_FILE_INPUT_BYTES) return null;
        return Array.from(buf);
    }
    if (raw && typeof raw === 'object') {
        const bytes = Object.values(raw);
        if (bytes.length === 0 || bytes.length > MAX_FILE_INPUT_BYTES) return null;
        return bytes;
    }
    return null;
};

// Classify uploaded bytes by magic numbers. Authoritative over the
// client-reported mime, which is spoofable and often missing.
const sniffFileKind = (b) => {
    if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image'; // PNG
    if (b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image';                  // JPEG
    if (b.length > 2 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image';                  // GIF
    if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {              // RIFF
        if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image';           // WEBP
        if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio';           // WAVE
    }
    if (b.length > 2 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio';                  // MP3 (ID3)
    if (b.length > 1 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio';                          // MP3 (frame sync)
    if (b.length > 3 && b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio'; // Ogg
    if (b.length > 3 && b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'audio'; // FLAC
    if (b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio'; // MP4/M4A (ftyp)
    return null;
};

// Meta passed as oninput's third argument. Mirrors game-session.js.
const buildFileMeta = (bytes, input) => {
    const contentType = (typeof input.contentType === 'string' && input.contentType.length <= 100)
        ? input.contentType : null;
    let kind = sniffFileKind(bytes);
    if (!kind && contentType) {
        if (contentType.indexOf('image/') === 0) kind = 'image';
        else if (contentType.indexOf('audio/') === 0) kind = 'audio';
    }
    const fileName = typeof input.fileName === 'string' ? input.fileName.slice(0, 128) : null;
    return { kind, contentType, fileName };
};

class LocalDispatcher {
    /**
     * @param {object} game — the game instance (extends squish Game)
     * @param {number} playerId — the local player's id
     */
    constructor(game, playerId) {
        this.game = game;
        this.playerId = Number(playerId);
    }

    /**
     * Accepts the JSON string the InputHandler would have sent over the
     * WebSocket. Drop-in replacement for the socket send function.
     */
    handleMessage(msg) {
        let input;
        try {
            input = JSON.parse(msg);
        } catch (e) {
            return;
        }
        this.handleInput(input);
    }

    handleInput(input) {
        if (!input || typeof input !== 'object' || typeof input.type !== 'string') return;

        const pid = this.playerId;

        try {
            if (input.type === 'click') {
                const data = input.data;
                if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
                this._handleClick(data);
            } else if (input.type === 'keydown') {
                if (typeof input.key !== 'string' || input.key.length > 20) return;
                this.game.handleKeyDown && this.game.handleKeyDown(pid, input.key);
            } else if (input.type === 'keyup') {
                if (typeof input.key !== 'string' || input.key.length > 20) return;
                this.game.handleKeyUp && this.game.handleKeyUp(pid, input.key);
            } else if (input.type === 'mouseup') {
                this.game.handleMouseUp && this.game.handleMouseUp(pid, input.data);
            } else if (input.type === 'input') {
                if (input.gamepad) {
                    this.game.handleGamepadInput && this.game.handleGamepadInput(pid, input);
                } else {
                    const node = this.game.findNode(input.nodeId);
                    if (node && node.node && node.node.input) {
                        if (node.node.input.type === 'file') {
                            const fileBytes = decodeFileInput(input.input);
                            if (fileBytes) node.node.input.oninput(pid, fileBytes, buildFileMeta(fileBytes, input));
                        } else {
                            node.node.input.oninput(pid, input.input);
                        }
                    }
                }
            } else if (input.type === 'onhover') {
                const node = this.game.findNode(input.nodeId);
                if (node && node.node && node.node.onHover) node.node.onHover(pid);
            } else if (input.type === 'offhover') {
                const node = this.game.findNode(input.nodeId);
                if (node && node.node && node.node.offHover) node.node.offHover(pid);
            }
        } catch (e) {
            console.error(`[LocalDispatcher] Error handling input type="${input.type}":`, e);
        }
    }

    // --- Private: click / hit-testing ---

    _handleClick(click) {
        if (!click || typeof click.x !== 'number' || typeof click.y !== 'number') return;
        if (click.x < 0 || click.y < 0 || click.x >= 100 || click.y >= 100) return;

        const clickedNode = this._findClick(click.x, click.y);

        if (clickedNode) {
            const realNode = this.game.findNode(clickedNode.id);
            if (realNode && realNode.node && realNode.node.handleClick) {
                realNode.node.handleClick(this.playerId, click.x, click.y);
            }
        }
    }

    _findClick(x, y) {
        let clicked = null;

        const layers = this.game.getLayers();
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const scale = layer.scale || { x: 1, y: 1 };
            clicked = this._findClickHelper(x, y, layer.root.node, null, scale, 0) || clicked;
        }

        return clicked;
    }

    _findClickHelper(x, y, node, clicked, scale, depth) {
        // Guard against deep/cyclic trees
        if (depth > 100) return clicked;

        if (node.playerIds && node.playerIds.length > 0 && !node.playerIds.find(p => p == this.playerId)) {
            return clicked;
        }

        if (node.coordinates2d && node.coordinates2d.length > 0) {
            const vertices = [];
            for (let i = 0; i < node.coordinates2d.length; i++) {
                const xOff = 100 - (scale.x * 100);
                const yOff = 100 - (scale.y * 100);
                const sx = node.coordinates2d[i][0] * ((100 - xOff) / 100) + (xOff / 2);
                const sy = node.coordinates2d[i][1] * ((100 - yOff) / 100) + (yOff / 2);
                vertices.push([sx, sy]);
            }

            if (vertices.length > 0) {
                let isInside = false;
                let minX = vertices[0][0], maxX = vertices[0][0];
                let minY = vertices[0][1], maxY = vertices[0][1];
                for (let i = 1; i < vertices.length; i++) {
                    minX = Math.min(vertices[i][0], minX);
                    maxX = Math.max(vertices[i][0], maxX);
                    minY = Math.min(vertices[i][1], minY);
                    maxY = Math.max(vertices[i][1], maxY);
                }

                if (!(x < minX || x > maxX || y < minY || y > maxY)) {
                    let ii = 0, jj = vertices.length - 1;
                    for (ii, jj; ii < vertices.length; jj = ii++) {
                        if ((vertices[ii][1] > y) !== (vertices[jj][1] > y) &&
                            x < (vertices[jj][0] - vertices[ii][0]) * (y - vertices[ii][1]) / (vertices[jj][1] - vertices[ii][1]) + vertices[ii][0]) {
                            isInside = !isInside;
                        }
                    }
                }

                if (isInside) {
                    clicked = node;
                }
            }
        }

        if (node.children) {
            const childKeys = Object.keys(node.children);
            for (let i = 0; i < childKeys.length; i++) {
                const child = node.children[childKeys[i]];
                if (child && child.node) {
                    clicked = this._findClickHelper(x, y, child.node, clicked, scale, depth + 1);
                }
            }
        }

        return clicked;
    }
}

module.exports = LocalDispatcher;
