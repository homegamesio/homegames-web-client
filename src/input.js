/**
 * Input handler — translates DOM events (mouse, touch, keyboard) into
 * game protocol messages sent over the WebSocket.
 *
 * Owns the hit-testing logic: uses the thingIndices from the Renderer
 * to determine what was clicked and whether to show text/file input prompts.
 */

const GamepadInput = require('./gamepad-input');

const { fitImageToSize } = require('./image-fit');

// Upload cap: matches the platform's single-asset limit, and keeps the
// wire message (base64 + JSON envelope, ~1.35x the file) safely under the
// server's 10MB websocket payload cap — oversized messages get the whole
// connection terminated by ws, not just the message dropped.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Encode bytes as base64 without blowing the call stack on MB-sized files
// (String.fromCharCode.apply is limited by max argument count).
const uint8ToBase64 = (bytes) => {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
};

class InputHandler {
    constructor(canvas, sendFn, getThingIndices, assetManager, gamepadOptions = {}) {
        this.canvas = canvas;
        this.send = sendFn;
        this.getThingIndices = getThingIndices;
        this.assetManager = assetManager;

        this.mouseDown = false;
        this.mousePos = null;
        this._pressClickSent = false;
        this.squishVersion = null;  // set by the session once known (init message / local metadata)
        this._lastClientPos = null;
        this.keysDown = {};
        this._lastKeyRepeat = {};        // per-key timestamp of last sent keydown
        this._keyRepeatIntervalMs = 33;  // ~30 repeats/sec, decoupled from frame rate
        this.currentHover = null;
        this.clickStopper = null;
        this.spectating = false;
        this.bezelInfo = { x: 0, y: 0 };
        this.clientWidth = 0;
        this.clientHeight = 0;

        this._boundHandlers = {};
        this._attached = false;

        this.gamepads = gamepadOptions === false ? null : new GamepadInput(sendFn, gamepadOptions);
        this._focused = true;
    }

    attach() {
        if (this._attached) return;
        this._attached = true;
        this._focused = typeof document.hasFocus !== 'function' || document.hasFocus();

        const h = this._boundHandlers;

        h.mousedown = (e) => {
            this._touchActive = false;
            this.mouseDown = true;
            this._pressClickSent = false;
            this.mousePos = [e.clientX, e.clientY];
            this._lastClientPos = [e.clientX, e.clientY];
            this.assetManager.unlockAudio();
        };

        h.mouseup = (e) => {
            this.mousePos = [e.clientX, e.clientY];
            this._lastClientPos = [e.clientX, e.clientY];
            this._sendPendingClick(this._canClick(e.clientX, e.clientY));
            this.mouseDown = false;
            this._sendMouseUp(e.clientX, e.clientY);
        };

        h.mousemove = (e) => {
            // If we think the button is down but nothing is actually pressed,
            // the mouseup happened outside the window where our listener can't
            // fire. Clear the stale state so we don't fire phantom clicks when
            // the pointer re-enters the canvas.
            if (this.mouseDown && e.buttons === 0) {
                this.mouseDown = false;
            }
            this.mousePos = [e.clientX + window.scrollX, e.clientY + window.scrollY];
            this._lastClientPos = [e.clientX, e.clientY];
        };

        h.touchstart = (e) => {
            // This handler sits on window, and preventDefault on touchstart
            // suppresses the synthesized click for whatever was tapped — on an
            // embedding page (the Studio on mobile) that kills every button
            // the moment a session starts. Only claim touches that begin on
            // the game canvas; everything else belongs to the page.
            if (e.target !== this.canvas) {
                this._touchActive = false;
                return;
            }
            e.preventDefault();
            this._touchActive = true;
            this.mouseDown = true;
            this._pressClickSent = false;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
            this._lastClientPos = [e.touches[0].clientX, e.touches[0].clientY];
            this.assetManager.unlockAudio();
        };

        h.touchmove = (e) => {
            e.preventDefault();
            this.mouseDown = true;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
            this._lastClientPos = [e.touches[0].clientX, e.touches[0].clientY];
        };

        h.touchend = (e) => {
            // Releases of touches we never claimed (page UI taps) aren't ours
            if (!this._touchActive) return;
            // touches is empty by touchend; the lifted finger is in changedTouches.
            const touch = e.changedTouches && e.changedTouches[0];
            if (touch) {
                // iOS only opens a file picker from an activation-triggering
                // event's call stack — touchend qualifies, the rAF tick() that
                // handles other clicks does not (and touchstart doesn't
                // either). So file-input taps must be resolved synchronously
                // right here; _handleClick skips them for touch interactions.
                const clickInfo = this._canClick(
                    touch.clientX + window.scrollX,
                    touch.clientY + window.scrollY
                );
                if (clickInfo.action === 'file') {
                    this._promptFileUpload(clickInfo.nodeId);
                } else {
                    this.mousePos = [touch.clientX, touch.clientY];
                    this._sendPendingClick(clickInfo);
                }
                this.mouseDown = false;
                this._sendMouseUp(touch.clientX, touch.clientY);
            }
            this.mouseDown = false;
        };

        h.touchcancel = () => {
            // Touch was taken over by the OS (gesture, notification shade) —
            // report the release at the last known position so the server can
            // close out the press (drag-end / offClick).
            if (this.mouseDown && this._lastClientPos) {
                this._sendMouseUp(this._lastClientPos[0], this._lastClientPos[1]);
            }
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
                // Only emit on the initial press. OS auto-repeat fires keydown
                // many times/sec; those are ignored here, and tick() emits
                // repeats at a fixed cadence so we don't flood the server's
                // input rate limiter.
                if (!this.keysDown[e.key]) {
                    this.send(JSON.stringify({ type: 'keydown', key: e.key }));
                    this._lastKeyRepeat[e.key] = Date.now();
                }
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

        h.blur = () => {
            this._focused = false;
            this.gamepads?.release();
            this._releaseKeys();
            // Window lost focus (alt-tab, switched app) while the button was
            // held — we won't get the mouseup, so clear the held state and
            // tell the server the press ended where we last saw the pointer.
            if (this.mouseDown && this._lastClientPos) {
                this._sendMouseUp(this._lastClientPos[0], this._lastClientPos[1]);
            }
            this.mouseDown = false;
        };

        h.focus = () => { this._focused = true; };
        h.visibilitychange = () => {
            if (document.hidden) {
                this.gamepads?.release();
                this._releaseKeys();
            }
        };

        window.addEventListener('mousedown', h.mousedown);
        window.addEventListener('mouseup', h.mouseup);
        window.addEventListener('mousemove', h.mousemove);
        window.addEventListener('blur', h.blur);
        window.addEventListener('focus', h.focus);
        document.addEventListener('visibilitychange', h.visibilitychange);
        window.addEventListener('touchstart', h.touchstart, { passive: false });
        this.canvas.addEventListener('touchmove', h.touchmove, { passive: false });
        window.addEventListener('touchend', h.touchend);
        window.addEventListener('touchcancel', h.touchcancel);
        document.addEventListener('keydown', h.keydown);
        document.addEventListener('keyup', h.keyup);
    }

    detach() {
        if (!this._attached) return;
        this._attached = false;
        this.gamepads?.release();
        this._releaseKeys();

        const h = this._boundHandlers;
        window.removeEventListener('mousedown', h.mousedown);
        window.removeEventListener('mouseup', h.mouseup);
        window.removeEventListener('mousemove', h.mousemove);
        window.removeEventListener('blur', h.blur);
        window.removeEventListener('focus', h.focus);
        document.removeEventListener('visibilitychange', h.visibilitychange);
        window.removeEventListener('touchstart', h.touchstart);
        this.canvas.removeEventListener('touchmove', h.touchmove);
        window.removeEventListener('touchend', h.touchend);
        window.removeEventListener('touchcancel', h.touchcancel);
        document.removeEventListener('keydown', h.keydown);
        document.removeEventListener('keyup', h.keyup);
    }

    /**
     * Called each animation frame. Processes pending mouse position,
     * handles held keys, and performs click/hover logic.
     */
    tick() {
        if (!this._attached) return;
        // Repeat held keys at a fixed cadence, decoupled from the rAF frame
        // rate (which can be 120Hz+ on high-refresh displays and would otherwise
        // blow the server's input rate limit).
        const nowTs = Date.now();
        Object.keys(this.keysDown).filter(k => this.keysDown[k]).forEach(k => {
            if (nowTs - (this._lastKeyRepeat[k] || 0) >= this._keyRepeatIntervalMs) {
                this.send(JSON.stringify({ type: 'keydown', key: k }));
                this._lastKeyRepeat[k] = nowTs;
            }
        });

        if (this._focused && !document.hidden && !this.spectating) this.gamepads?.tick();
        else this.gamepads?.release();

        if (!this.mousePos) return;

        const clickInfo = this._canClick(this.mousePos[0], this.mousePos[1]);

        // Press + drag. The first tick of a physical press sends a click
        // marked press: true. What happens while held depends on the game's
        // squish version:
        //   1.4.4+ — one press = one onClick. Movement sends mousemove
        //   (~30ms throttle), which the server routes to the drag handlers
        //   (handleMouseMove / onDrag); release sends mouseup (offClick).
        //   older  — clicks are re-sent while held (~30ms), the repeated-
        //   click contract those games' interactions were built on.
        if (this.mouseDown && !this.clickStopper) {
            if (!this._pressClickSent) {
                this._pressClickSent = true;
                this._handleClick(clickInfo, true);
            } else if (this._usesSingleClickContract()) {
                this._sendMouseMove(this.mousePos[0], this.mousePos[1]);
            } else {
                this._handleClick(clickInfo, false);
            }
            this.clickStopper = setTimeout(() => { this.clickStopper = null; }, 30);
        }

        // Hover tracking. onhover/offhover fire for clickable nodes (as
        // before) and for nodes that declared an onHover handler — the
        // squished state marks those, mirroring how handleClick presence
        // drives clicks. The pointer cursor stays clickable-only: hoverable
        // alone doesn't imply "you can click this".
        if (clickInfo.isClickable || clickInfo.action || clickInfo.isHoverable) {
            if (!this.currentHover || Number(clickInfo.nodeId) !== Number(this.currentHover)) {
                if (this.currentHover) this._offHover(this.currentHover);
                this.currentHover = clickInfo.nodeId;
                this._onHover(clickInfo.nodeId);
            }
            this.canvas.style.cursor = (clickInfo.isClickable || clickInfo.action) ? 'pointer' : 'initial';
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

    _releaseKeys() {
        for (const timer of Object.values(this._keyUpTimers || {})) clearTimeout(timer);
        this._keyUpTimers = {};
        for (const key of Object.keys(this.keysDown)) {
            if (this.keysDown[key]) this.send(JSON.stringify({ type: 'keyup', key }));
        }
        this.keysDown = {};
        this._lastKeyRepeat = {};
    }

    _keyMatters(event) {
        return (event.key.length === 1 && event.key >= ' ' && event.key <= 'z') ||
            (event.keyCode >= 36 && event.keyCode <= 40) ||
            event.key === 'Meta' || event.key === 'Backspace' || event.key === 'Enter';
    }

    _sendMouseUp(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = (clientX - rect.left) / rect.width * 100;
        const clickY = (clientY - rect.top) / rect.height * 100;
        // Clamp off-canvas releases to the canvas edge instead of dropping
        // them — the server needs every release to close out presses
        // (drag-end / offClick), even ones that finish outside the canvas.
        const x = Math.min(99.99, Math.max(0, clickX));
        const y = Math.min(99.99, Math.max(0, clickY));
        this.send(JSON.stringify({ type: 'mouseup', data: { x, y } }));
    }

    // Whether the game's squish version uses the single-click contract
    // (onClick once per press, mousemove while held, mouseup on release).
    // Modern version strings are three digits ('142', '144'); anything else
    // ('0767' / '1000'-style) predates drag support entirely — both get the
    // legacy repeated-click behavior.
    _usesSingleClickContract() {
        const v = this.squishVersion;
        if (!v || !/^[1-9]\d{2}$/.test(v)) return false;
        return Number(v) >= 144;
    }

    // Held-pointer movement. Same coordinate math as _handleClick; clamped
    // to the canvas edge (like mouseup) so drags that wander off-canvas keep
    // tracking instead of going silent.
    _sendMouseMove(posX, posY) {
        const rect = this.canvas.getBoundingClientRect();
        const moveX = (posX - rect.left) / rect.width * 100;
        const moveY = (posY - rect.top) / rect.height * 100;
        const x = Math.min(99.99, Math.max(0, moveX));
        const y = Math.min(99.99, Math.max(0, moveY));
        this.send(JSON.stringify({ type: 'mousemove', data: { x, y } }));
    }

    _onHover(nodeId) {
        this.send(JSON.stringify({ type: 'onhover', nodeId }));
    }

    _offHover(nodeId) {
        this.send(JSON.stringify({ type: 'offhover', nodeId }));
    }

    // A press can begin and end between two animation frames. Deliver it before
    // its release, without duplicating a click already sent by tick().
    _sendPendingClick(clickInfo) {
        if (!this.mouseDown || this._pressClickSent || this.spectating || !this._focused) return;
        this._pressClickSent = true;
        this._handleClick(clickInfo, true);
    }

    _handleClick(clickInfo, isNewPress) {
        if (!this.mousePos) return;

        if (clickInfo.action) {
            if (clickInfo.action === 'text') {
                this.mouseDown = false;
                const textInput = prompt('Input text');
                // A cancelled prompt returns null — nothing to deliver.
                if (textInput !== null) {
                    this.send(JSON.stringify({ type: 'input', input: textInput, nodeId: clickInfo.nodeId }));
                }
            } else if (clickInfo.action === 'file') {
                this.mouseDown = false;
                // Touch taps open the picker synchronously from touchend
                // (iOS user-activation requirement); prompting here too would
                // double-open on platforms that allow both.
                if (!this._touchActive) {
                    this._promptFileUpload(clickInfo.nodeId);
                }
            }
        } else {
            const x = this.mousePos[0];
            const y = this.mousePos[1];
            const rect = this.canvas.getBoundingClientRect();
            const clickX = (x - rect.left) / rect.width * 100;
            const clickY = (y - rect.top) / rect.height * 100;
            if (clickX >= 0 && clickX <= 100 && clickY >= 0 && clickY <= 100) {
                // press: true marks the start of a physical press so the
                // server can track it through the held re-sends and mouseup
                // (drag support); re-sends while held carry no flag.
                const data = { x: clickX, y: clickY };
                if (isNewPress) data.press = true;
                this.send(JSON.stringify({ type: 'click', data }));
            }
        }
    }

    /**
     * Show the OS file picker for a file-input node and send the selected
     * file's bytes as base64. Images over MAX_UPLOAD_BYTES are transparently
     * shrunk to fit (see image-fit.js); other oversized files are rejected.
     * The server (and LocalDispatcher) decode the base64 back into a byte
     * array before handing it to the game's oninput, along with
     * { kind, contentType, fileName } derived from the bytes and the
     * metadata sent here.
     */
    _promptFileUpload(nodeId) {
        const inputEl = document.createElement('input');
        inputEl.type = 'file';
        // The platform understands image and audio assets; the squished node
        // carries no per-node accept info, so this is the global filter.
        inputEl.accept = 'image/*,audio/*';
        inputEl.style.display = 'none';
        document.body.appendChild(inputEl);
        const cleanupInput = () => {
            if (inputEl.parentNode) inputEl.parentNode.removeChild(inputEl);
        };

        inputEl.onchange = async () => {
            const file = inputEl.files && inputEl.files[0];
            cleanupInput();
            if (!file) return;

            let upload = { blob: file, contentType: file.type || null, fileName: file.name || null };
            if (file.size > MAX_UPLOAD_BYTES) {
                // Oversized images are shrunk to fit instead of rejected.
                // fitImageToSize throws for anything it can't decode as an
                // image (audio, corrupt files), which falls back to the cap.
                try {
                    upload = await fitImageToSize(file, MAX_UPLOAD_BYTES);
                } catch (e) {
                    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
                    const maxMb = MAX_UPLOAD_BYTES / (1024 * 1024);
                    alert(`That file is ${sizeMb}MB — uploads are limited to ${maxMb}MB, and it couldn't be resized automatically.`);
                    return;
                }
            }

            const fileReader = new FileReader();
            fileReader.onerror = () => {
                alert('Could not read that file. Please try a different one.');
            };
            fileReader.onload = () => {
                this.send(JSON.stringify({
                    type: 'input',
                    fileEncoding: 'base64',
                    contentType: upload.contentType,
                    fileName: upload.fileName,
                    input: uint8ToBase64(new Uint8Array(fileReader.result)),
                    nodeId
                }));
            };
            fileReader.readAsArrayBuffer(upload.blob);
        };

        // Clean up if user cancels the file dialog
        inputEl.addEventListener('cancel', cleanupInput);
        inputEl.click();
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
        let isHoverable = false;
        let action = null;
        let nodeId = null;

        const rect = this.canvas.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return { isClickable, isHoverable, action, nodeId };

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
                isHoverable = !!chunk[4];
            }
        }

        return { isClickable, isHoverable, action, nodeId };
    }
}

module.exports = InputHandler;
