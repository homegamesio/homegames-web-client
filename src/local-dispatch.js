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
                            node.node.input.oninput(pid, Object.values(input.input || {}));
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
