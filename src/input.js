/**
 * Input handler — translates DOM events (mouse, touch, keyboard) into
 * game protocol messages sent over the WebSocket.
 *
 * Owns the hit-testing logic: uses the thingIndices from the Renderer
 * to determine what was clicked and whether to show text/file input prompts.
 */

let Homepad = null;
try { Homepad = require('homepad').Homepad; } catch (e) { /* optional */ }

class InputHandler {
    constructor(canvas, sendFn, getThingIndices, assetManager) {
        this.canvas = canvas;
        this.send = sendFn;
        this.getThingIndices = getThingIndices;
        this.assetManager = assetManager;

        this.mouseDown = false;
        this.mousePos = null;
        this.keysDown = {};
        this.currentHover = null;
        this.clickStopper = null;
        this.spectating = false;
        this.bezelInfo = { x: 0, y: 0 };
        this.clientWidth = 0;
        this.clientHeight = 0;

        this._boundHandlers = {};
        this._attached = false;

        // Gamepad support (via homepad if available)
        this._homepad = null;
        if (Homepad) {
            try { this._homepad = new Homepad(); } catch (e) { /* no window */ }
        }
    }

    attach() {
        if (this._attached) return;
        this._attached = true;

        const h = this._boundHandlers;

        h.mousedown = (e) => {
            this.mouseDown = true;
            this.mousePos = [e.clientX, e.clientY];
            this.assetManager.unlockAudio();
        };

        h.mouseup = (e) => {
            this.mouseDown = false;
            this.mousePos = [e.clientX, e.clientY];
            const rect = this.canvas.getBoundingClientRect();
            const clickX = (this.mousePos[0] - rect.left) / rect.width * 100;
            const clickY = (this.mousePos[1] - rect.top) / rect.height * 100;
            this.send(JSON.stringify({ type: 'mouseup', data: { x: clickX, y: clickY } }));
        };

        h.mousemove = (e) => {
            this.mousePos = [e.clientX + window.scrollX, e.clientY + window.scrollY];
        };

        h.touchstart = (e) => {
            e.preventDefault();
            this.mouseDown = true;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
            this.assetManager.unlockAudio();
        };

        h.touchmove = (e) => {
            e.preventDefault();
            this.mouseDown = true;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
        };

        h.touchend = () => {
            this.mouseDown = false;
        };

        h.keydown = (e) => {
            this.assetManager.unlockAudio();
            if (this._keyMatters(e) && !this.keysDown['Meta']) {
                e.preventDefault();
                // If there's a pending keyup debounce for this key, cancel it —
                // the key is still physically held (macOS accent popup pattern).
                if (this._keyUpTimers && this._keyUpTimers[e.key]) {
                    clearTimeout(this._keyUpTimers[e.key]);
                    delete this._keyUpTimers[e.key];
                }
                this.send(JSON.stringify({ type: 'keydown', key: e.key }));
                this.keysDown[e.key] = true;
            }
        };

        h.keyup = (e) => {
            if (this._keyMatters(e)) {
                e.preventDefault();
                // Debounce keyup: on macOS, holding a key triggers a synthetic
                // keyup after ~1s (accent popup), immediately followed by keydown
                // if the key is still held. Delay clearing keysDown so the
                // rAF-based key repeat in tick() keeps sending during the gap.
                if (!this._keyUpTimers) this._keyUpTimers = {};
                if (this._keyUpTimers[e.key]) clearTimeout(this._keyUpTimers[e.key]);
                this._keyUpTimers[e.key] = setTimeout(() => {
                    this.keysDown[e.key] = false;
                    delete this._keyUpTimers[e.key];
                    this.send(JSON.stringify({ type: 'keyup', key: e.key }));
                }, 50);
            }
        };

        window.addEventListener('mousedown', h.mousedown);
        window.addEventListener('mouseup', h.mouseup);
        window.addEventListener('mousemove', h.mousemove);
        window.addEventListener('touchstart', h.touchstart, { passive: false });
        this.canvas.addEventListener('touchmove', h.touchmove, { passive: false });
        window.addEventListener('touchend', h.touchend);
        document.addEventListener('keydown', h.keydown);
        document.addEventListener('keyup', h.keyup);
    }

    detach() {
        if (!this._attached) return;
        this._attached = false;

        const h = this._boundHandlers;
        window.removeEventListener('mousedown', h.mousedown);
        window.removeEventListener('mouseup', h.mouseup);
        window.removeEventListener('mousemove', h.mousemove);
        window.removeEventListener('touchstart', h.touchstart);
        this.canvas.removeEventListener('touchmove', h.touchmove);
        window.removeEventListener('touchend', h.touchend);
        document.removeEventListener('keydown', h.keydown);
        document.removeEventListener('keyup', h.keyup);
    }

    /**
     * Called each animation frame. Processes pending mouse position,
     * handles held keys, and performs click/hover logic.
     */
    tick() {
        // Repeat held keys
        Object.keys(this.keysDown).filter(k => this.keysDown[k]).forEach(k => {
            this.send(JSON.stringify({ type: 'keydown', key: k }));
        });

        // Poll gamepads (throttled — only send when state changes)
        if (this._homepad) {
            try {
                const gamepads = this._homepad.getGamepads();
                if (gamepads && gamepads.length) {
                    gamepads.forEach((gp) => {
                        const state = this._homepad.getGamepadState(gp.index);
                        const stateStr = JSON.stringify(state);
                        if (!this._lastGamepadState || this._lastGamepadState[gp.index] !== stateStr) {
                            if (!this._lastGamepadState) this._lastGamepadState = {};
                            this._lastGamepadState[gp.index] = stateStr;
                            this.send(JSON.stringify({
                                type: 'input',
                                gamepad: true,
                                input: state,
                            }));
                        }
                    });
                }
            } catch (e) { /* ignore gamepad errors */ }
        }

        if (!this.mousePos) return;

        const clickInfo = this._canClick(this.mousePos[0], this.mousePos[1]);

        // Click on hold
        if (this.mouseDown && !this.clickStopper) {
            this._handleClick(clickInfo);
            this.clickStopper = setTimeout(() => { this.clickStopper = null; }, 30);
        }

        // Hover tracking
        if (clickInfo.isClickable || clickInfo.action) {
            if (!this.currentHover || Number(clickInfo.nodeId) !== Number(this.currentHover)) {
                if (this.currentHover) this._offHover(this.currentHover);
                this.currentHover = clickInfo.nodeId;
                this._onHover(clickInfo.nodeId);
            }
            this.canvas.style.cursor = 'pointer';
        } else {
            if (this.currentHover) {
                this._offHover(this.currentHover);
                this.currentHover = null;
            }
            this.canvas.style.cursor = 'initial';
        }

        this.mousePos = null;
    }

    // --- Private ---

    _keyMatters(event) {
        return (event.key.length === 1 && event.key >= ' ' && event.key <= 'z') ||
            (event.keyCode >= 36 && event.keyCode <= 40) ||
            event.key === 'Meta' || event.key === 'Backspace';
    }

    _onHover(nodeId) {
        this.send(JSON.stringify({ type: 'onhover', nodeId }));
    }

    _offHover(nodeId) {
        this.send(JSON.stringify({ type: 'offhover', nodeId }));
    }

    _handleClick(clickInfo) {
        if (!this.mousePos) return;

        if (clickInfo.action) {
            if (clickInfo.action === 'text') {
                this.mouseDown = false;
                const textInput = prompt('Input text');
                this.send(JSON.stringify({ type: 'input', input: textInput, nodeId: clickInfo.nodeId }));
            } else if (clickInfo.action === 'file') {
                this.mouseDown = false;
                const inputEl = document.createElement('input');
                inputEl.type = 'file';
                inputEl.style.display = 'none';
                document.body.appendChild(inputEl);
                const cleanupInput = () => {
                    if (inputEl.parentNode) document.body.removeChild(inputEl);
                };
                inputEl.onchange = () => {
                    if (inputEl.files.length > 0) {
                        const fileReader = new FileReader();
                        fileReader.onload = () => {
                            this.send(JSON.stringify({
                                type: 'input',
                                input: new Uint8Array(fileReader.result),
                                nodeId: clickInfo.nodeId
                            }));
                        };
                        fileReader.readAsArrayBuffer(inputEl.files[0]);
                    }
                    cleanupInput();
                };
                // Clean up if user cancels the file dialog
                inputEl.addEventListener('cancel', cleanupInput);
                inputEl.click();
            }
        } else {
            const x = this.mousePos[0];
            const y = this.mousePos[1];
            const rect = this.canvas.getBoundingClientRect();
            const clickX = (x - rect.left) / rect.width * 100;
            const clickY = (y - rect.top) / rect.height * 100;
            if (clickX >= 0 && clickX <= 100 && clickY >= 0 && clickY <= 100) {
                this.send(JSON.stringify({ type: 'click', data: { x: clickX, y: clickY } }));
            }
        }
    }

    _translateX(x) {
        const rect = this.canvas.getBoundingClientRect();
        return (x * rect.width / 100) + rect.left;
    }

    _translateY(y) {
        const rect = this.canvas.getBoundingClientRect();
        return (y * rect.height / 100) + rect.top;
    }

    _canClick(x, y) {
        let isClickable = false;
        let action = null;
        let nodeId = null;

        const rect = this.canvas.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return { isClickable, action, nodeId };

        const thingIndices = this.getThingIndices();

        for (const chunkIndex in thingIndices) {
            const chunk = thingIndices[chunkIndex];
            let vertices = chunk[3];
            if (!vertices || !vertices.length) continue;

            // Normalize flat array to pairs
            if (!vertices[0].length) {
                const pairs = new Array(vertices.length / 2);
                for (let i = 0; i < vertices.length; i += 2) {
                    pairs[i / 2] = [vertices[i], vertices[i + 1]];
                }
                vertices = pairs;
            }

            // Point-in-polygon
            let inside = false;
            let minX = this._translateX(vertices[0][0]);
            let maxX = minX;
            let minY = this._translateY(vertices[0][1]);
            let maxY = minY;

            for (let i = 1; i < vertices.length; i++) {
                const vx = this._translateX(vertices[i][0]);
                const vy = this._translateY(vertices[i][1]);
                if (vx < minX) minX = vx;
                if (vx > maxX) maxX = vx;
                if (vy < minY) minY = vy;
                if (vy > maxY) maxY = vy;
            }

            if (!(x < minX || x > maxX || y < minY || y > maxY)) {
                let i = 0, j = vertices.length - 1;
                for (; i < vertices.length; j = i++) {
                    const yi = this._translateY(vertices[i][1]);
                    const yj = this._translateY(vertices[j][1]);
                    const xi = this._translateX(vertices[i][0]);
                    const xj = this._translateX(vertices[j][0]);
                    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                        inside = !inside;
                    }
                }
            }

            if (inside) {
                isClickable = chunk[0];
                action = chunk[1];
                nodeId = chunk[2];
            }
        }

        return { isClickable, action, nodeId };
    }
}

module.exports = InputHandler;
