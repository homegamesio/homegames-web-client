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
const { MAX_UPLOAD_BYTES } = require('homegames-common/media-upload');

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
        this._touchActive = false;
        this._lastTouchTime = -Infinity;
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
        this.pointerLockEnabled = false;
        this.pointerLockSuspended = false;
        this._pointerLocked = false;
        this._pointerLockPending = false;
        this._pointerLockCancelled = false;
        this._pointerLockOnRelease = false;
        this._pointerDelta = { dx: 0, dy: 0 };
        this._lastPointerMove = 0;
    }

    // A game may opt in, but only a physical canvas mouse gesture requests
    // capture. Unsupported or denied requests keep the ordinary drag controls.
    setPointerLockEnabled(enabled) {
        this.pointerLockEnabled = enabled === true;
        if (!this.pointerLockEnabled) this._releasePointerCapture();
    }

    // Menus may suspend an opted-in game's capture for one player without
    // changing the game's capability or requesting a lock outside a gesture.
    setPointerLockSuspended(suspended) {
        const value = suspended === true;
        if (this.pointerLockSuspended === value) return;
        this.pointerLockSuspended = value;
        if (value) this._releasePointerCapture();
    }

    _canCapturePointer() {
        return this.pointerLockEnabled && !this.pointerLockSuspended;
    }

    attach() {
        if (this._attached) return;
        this._attached = true;
        this._focused = typeof document.hasFocus !== 'function' || document.hasFocus();

        const h = this._boundHandlers;
        // Reattach can happen while a previous native request is settling.
        document.removeEventListener('pointerlockchange', h.pointerlockchange);
        document.removeEventListener('pointerlockerror', h.pointerlockerror);

        h.mousedown = (e) => {
            if (this._isTouchMouseEvent(e)) return;
            this._pointerLockOnRelease = false;
            if (this._isControlEvent(e)) return;
            // A new physical press must not be swallowed by the previous
            // press's repeat throttle (especially short push-to-talk bursts).
            clearTimeout(this.clickStopper); this.clickStopper = null;
            if (e.target === this.canvas) this.assetManager.liveMedia?.hold('pointer');
            this._touchActive = false;
            this.mouseDown = true;
            this._pressClickSent = false;
            this.mousePos = this._hasPointerLock() ? this._canvasCenter() : [e.clientX, e.clientY];
            this._lastClientPos = this.mousePos.slice();
            this._pressOrigin = this.mousePos.slice();
            this.assetManager.unlockAudio();
            const captureGesture = this._canCapturePointer() && !this.spectating &&
                e.target === this.canvas && e.button === 0 && !e.sourceCapabilities?.firesTouchEvents &&
                !this._hasPointerLock() && !this._pointerLockPending &&
                typeof this.canvas.requestPointerLock === 'function';
            // An iframe's first mousedown can arrive before its native focus
            // event. Complete that same gesture on mouseup once focus arrives.
            this._pointerLockOnRelease = captureGesture && !this._focused;
            if (captureGesture && this._focused) {
                // Deliver the acquisition press at its original coordinates
                // exactly once (e.g. an Enter button), before capture centers
                // future clicks. The native request must stay in this gesture.
                this._sendPendingClick(this._canClick(this.mousePos[0], this.mousePos[1]));
                // A local click can synchronously stop/redirect its session.
                if (!this._attached || !this._canCapturePointer() || !this._focused || this.spectating) return;
                this.clickStopper = setTimeout(() => { this.clickStopper = null; }, 30);
                this._requestPointerLock();
            }
        };

        h.mouseup = (e) => {
            if (this._isTouchMouseEvent(e)) return;
            this.assetManager.liveMedia?.release('pointer');
            this.mousePos = this._hasPointerLock() ? this._canvasCenter() : [e.clientX, e.clientY];
            this._lastClientPos = this.mousePos.slice();
            const releasePos = this.mousePos.slice();
            this._sendPendingClick(this._canClick(this.mousePos[0], this.mousePos[1]));
            // Teardown already releases the press and clears mousePos.
            if (!this._attached) return;
            this.mouseDown = false;
            this._sendMouseUp(releasePos[0], releasePos[1]);
            const captureOnRelease = this._pointerLockOnRelease;
            this._pointerLockOnRelease = false;
            if (captureOnRelease && this._attached && this._canCapturePointer() && this._focused && !this.spectating &&
                e.target === this.canvas && e.button === 0 && !e.sourceCapabilities?.firesTouchEvents &&
                !this._hasPointerLock() && !this._pointerLockPending) this._requestPointerLock();
        };

        h.mousemove = (e) => {
            if (this._isTouchMouseEvent(e)) return;
            if (this._hasPointerLock()) {
                if (this.mouseDown && e.buttons === 0) this._releasePointerPress();
                if (Number.isFinite(e.movementX) && Number.isFinite(e.movementY)) {
                    // Relative CSS pixels, bounded to the dispatcher's wire
                    // limit even if a stalled frame accumulates many events.
                    this._pointerDelta.dx = Math.max(-4096, Math.min(4096, this._pointerDelta.dx + e.movementX));
                    this._pointerDelta.dy = Math.max(-4096, Math.min(4096, this._pointerDelta.dy + e.movementY));
                }
                return; // Captured motion must never also become a drag.
            }
            // If we think the button is down but nothing is actually pressed,
            // the mouseup happened outside the window where our listener can't
            // fire. Clear the stale state so we don't fire phantom clicks when
            // the pointer re-enters the canvas.
            if (this.mouseDown && e.buttons === 0) {
                this.assetManager.liveMedia?.release('pointer');
                this.mouseDown = false;
            }
            this.mousePos = [e.clientX + window.scrollX, e.clientY + window.scrollY];
            this._lastClientPos = [e.clientX, e.clientY];
        };

        h.touchstart = (e) => {
            this._pointerLockOnRelease = false;
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
            // Claiming a canvas touch suppresses the synthesized mouse click
            // that would normally focus an embedded game. Treat this direct
            // gesture as input focus so the first tap can reach the game too.
            // Page-control touches return above; blur still releases input.
            // preventDefault also suppresses native focus transfer. Move DOM
            // focus into the canvas so a later keyboard press cannot activate
            // the embedding toolbar's previously focused button.
            if (typeof this.canvas.focus === 'function') {
                if (this.canvas.tabIndex < 0) this.canvas.tabIndex = -1;
                this.canvas.focus({ preventScroll: true });
            }
            this._focused = true;
            this._touchActive = true;
            this._lastTouchTime = Date.now();
            clearTimeout(this.clickStopper); this.clickStopper = null;
            this.assetManager.liveMedia?.hold('pointer');
            this.mouseDown = true;
            this._pressClickSent = false;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
            this._lastClientPos = [e.touches[0].clientX, e.touches[0].clientY];
            this._pressOrigin = this.mousePos.slice();
            this.assetManager.unlockAudio();
        };

        h.touchmove = (e) => {
            if (!this._touchActive) return;
            e.preventDefault();
            this._lastTouchTime = Date.now();
            this.mouseDown = true;
            this.mousePos = [e.touches[0].clientX + window.scrollX, e.touches[0].clientY + window.scrollY];
            this._lastClientPos = [e.touches[0].clientX, e.touches[0].clientY];
        };

        h.touchend = (e) => {
            // Releases of touches we never claimed (page UI taps) aren't ours
            if (!this._touchActive) return;
            this.assetManager.liveMedia?.release('pointer');
            this._lastTouchTime = Date.now();
            // Cancel compatibility mouse events at release as well as start.
            // Keep this listener non-passive; native file pickers still open
            // synchronously below, within the touchend activation gesture.
            if (e.cancelable !== false) e.preventDefault?.();
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
            this._touchActive = false;
        };

        h.touchcancel = () => {
            if (!this._touchActive) return;
            this._lastTouchTime = Date.now();
            this.assetManager.liveMedia?.release('pointer');
            // Touch was taken over by the OS (gesture, notification shade) —
            // report the release at the last known position so the server can
            // close out the press (drag-end / offClick).
            if (this.mouseDown && this._lastClientPos) {
                this._sendMouseUp(this._lastClientPos[0], this._lastClientPos[1], true);
            }
            this.mouseDown = false;
            this._touchActive = false;
        };

        h.keydown = (e) => {
            // Frame controls own Enter/Space and text input. Do not let the
            // document-level game listener cancel their native activation.
            if (this._isControlEvent(e)) return;
            if (e.key === 'Escape' && (this._hasPointerLock() || this._pointerLockPending || this._pointerLockOnRelease)) {
                this._releasePointerCapture();
                return;
            }
            if (e.key === ' ') this.assetManager.liveMedia?.hold('space');
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
            if (e.key === ' ') this.assetManager.liveMedia?.release('space');
            if (this._isControlEvent(e)) {
                // Focus may have moved into the frame while a game key was held.
                if (this.keysDown[e.key]) {
                    clearTimeout(this._keyUpTimers?.[e.key]);
                    if (this._keyUpTimers) delete this._keyUpTimers[e.key];
                    delete this.keysDown[e.key]; delete this._lastKeyRepeat[e.key];
                    this.send(JSON.stringify({ type: 'keyup', key: e.key }));
                }
                return;
            }
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
            // Window lost focus (alt-tab, switched app) while the button was
            // held — we won't get the mouseup, so clear the held state and
            // tell the server the press ended where we last saw the pointer.
            this._releasePointerCapture();
        };

        h.focus = () => { this._focused = true; };
        h.visibilitychange = () => {
            if (document.hidden) {
                this._releasePointerCapture();
            }
        };
        h.pointerlockchange = () => {
            const wasLocked = this._pointerLocked;
            this._pointerLocked = this._hasPointerLock();
            this._pointerLockPending = false;
            this._clearPointerDelta();
            if (this._pointerLocked && (!this._attached || !this._canCapturePointer() ||
                this._pointerLockCancelled || this.spectating || !this._focused)) {
                this._releasePointerCapture();
            } else if (wasLocked && !this._pointerLocked) {
                this._releasePointerCapture();
            }
            this._removeDetachedPointerLockListeners();
        };
        h.pointerlockerror = () => {
            this._pointerLockPending = false;
            this._removeDetachedPointerLockListeners();
        };

        window.addEventListener('mousedown', h.mousedown);
        window.addEventListener('mouseup', h.mouseup);
        window.addEventListener('mousemove', h.mousemove);
        window.addEventListener('blur', h.blur);
        window.addEventListener('focus', h.focus);
        document.addEventListener('visibilitychange', h.visibilitychange);
        document.addEventListener('pointerlockchange', h.pointerlockchange);
        document.addEventListener('pointerlockerror', h.pointerlockerror);
        window.addEventListener('touchstart', h.touchstart, { passive: false });
        this.canvas.addEventListener('touchmove', h.touchmove, { passive: false });
        window.addEventListener('touchend', h.touchend, { passive: false });
        window.addEventListener('touchcancel', h.touchcancel);
        document.addEventListener('keydown', h.keydown);
        document.addEventListener('keyup', h.keyup);
    }

    detach() {
        this._textDialog?.close(); this._textDialog?.remove(); this._textDialog = null;
        if (!this._attached) return;
        this.assetManager.liveMedia?.release();
        this._attached = false;
        this._releasePointerCapture();

        const h = this._boundHandlers;
        window.removeEventListener('mousedown', h.mousedown);
        window.removeEventListener('mouseup', h.mouseup);
        window.removeEventListener('mousemove', h.mousemove);
        window.removeEventListener('blur', h.blur);
        window.removeEventListener('focus', h.focus);
        document.removeEventListener('visibilitychange', h.visibilitychange);
        this._removeDetachedPointerLockListeners();
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

        // A rolling 60 Hz deadline tolerates Date.now()'s integer rounding and
        // rAF jitter without accidentally halving look updates to 30 Hz.
        const pointerInterval = 1000 / 60;
        if (this._canCapturePointer() && this._hasPointerLock() && this._focused && !document.hidden && !this.spectating &&
            nowTs - this._lastPointerMove >= pointerInterval - 1 && (this._pointerDelta.dx || this._pointerDelta.dy)) {
            this.send(JSON.stringify({ type: 'pointermove', data: { ...this._pointerDelta } }));
            this._pointerDelta.dx = this._pointerDelta.dy = 0;
            this._lastPointerMove = this._lastPointerMove && nowTs - this._lastPointerMove < pointerInterval * 2 ?
                this._lastPointerMove + pointerInterval : nowTs;
        }

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
                this._sendPendingClick(clickInfo);
            } else if (this._hasPointerLock()) {
                // Captured presses fire once; relative look is sent separately.
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
        // drives clicks. Cursor selection is owned by the session.
        if (clickInfo.isClickable || clickInfo.action || clickInfo.isHoverable) {
            if (!this.currentHover || Number(clickInfo.nodeId) !== Number(this.currentHover)) {
                if (this.currentHover) this._offHover(this.currentHover);
                this.currentHover = clickInfo.nodeId;
                this._onHover(clickInfo.nodeId);
            }
        } else {
            if (this.currentHover) {
                this._offHover(this.currentHover);
                this.currentHover = null;
            }
        }

        this.mousePos = null;
    }

    // --- Private ---

    _hasPointerLock() {
        return document.pointerLockElement === this.canvas;
    }

    _canvasCenter() {
        const rect = this.canvas.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }

    _requestPointerLock() {
        if (!this._canCapturePointer()) return;
        this._pointerLockCancelled = false;
        this._pointerLockPending = true;
        try {
            const request = this.canvas.requestPointerLock();
            // Older browsers return void and report the result through events.
            if (request?.then) request.then(() => {
                this._boundHandlers.pointerlockchange();
            }, () => {
                this._boundHandlers.pointerlockerror();
            });
        } catch (_) {
            this._boundHandlers.pointerlockerror();
        }
    }

    _clearPointerDelta() {
        this._pointerDelta.dx = this._pointerDelta.dy = 0;
        this._lastPointerMove = 0;
    }

    _releasePointerPress() {
        this._pointerLockOnRelease = false;
        this.assetManager.liveMedia?.release('pointer');
        if (this.mouseDown && this._lastClientPos) this._sendMouseUp(...this._lastClientPos, true);
        this.mouseDown = false;
        this._touchActive = false;
        this._pressClickSent = false;
        this.mousePos = null;
        this._lastClientPos = null;
        clearTimeout(this.clickStopper); this.clickStopper = null;
    }

    _releasePointerCapture() {
        this._pointerLockCancelled = true;
        this.assetManager.liveMedia?.release();
        this.gamepads?.release();
        this._releaseKeys();
        this._releasePointerPress();
        this._clearPointerDelta();
        // Another local player's canvas (or the embedding page) owns its lock.
        if (this._hasPointerLock()) document.exitPointerLock?.();
    }

    _removeDetachedPointerLockListeners() {
        if (this._attached || this._pointerLockPending) return;
        // A request can finish after detach. Keep only these two listeners
        // until it settles so a late acquisition is immediately released.
        document.removeEventListener('pointerlockchange', this._boundHandlers.pointerlockchange);
        document.removeEventListener('pointerlockerror', this._boundHandlers.pointerlockerror);
    }

    _releaseKeys() {
        for (const timer of Object.values(this._keyUpTimers || {})) clearTimeout(timer);
        this._keyUpTimers = {};
        for (const key of Object.keys(this.keysDown)) {
            if (this.keysDown[key]) this.send(JSON.stringify({ type: 'keyup', key }));
        }
        this.keysDown = {};
        this._lastKeyRepeat = {};
    }

    _isControlEvent(event) {
        return !!event.target?.closest?.('button, a, input, select, textarea, [contenteditable="true"]');
    }

    _isTouchMouseEvent(event) {
        // One touch is already one game press. Some mobile browsers also
        // deliver compatibility mouse events on release, toggling buttons a
        // second time. Safari does not expose sourceCapabilities, so retain a
        // short, canvas-only fallback after our own touch gestures. Explicit
        // physical mouse input and the embedding page's controls stay usable.
        const fromTouch = event.sourceCapabilities?.firesTouchEvents;
        if (fromTouch === true) return true;
        if (fromTouch === false) return false;
        return event.target === this.canvas &&
            (this._touchActive || Date.now() - this._lastTouchTime < 800);
    }

    _keyMatters(event) {
        return (event.key.length === 1 && event.key >= ' ' && event.key <= 'z') ||
            (event.keyCode >= 36 && event.keyCode <= 40) ||
            event.key === 'Meta' || event.key === 'Backspace' || event.key === 'Enter' ||
            event.key === 'Escape' || event.key === 'Shift';
    }

    _sendMouseUp(clientX, clientY, cancelled = false) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = (clientX - rect.left) / rect.width * 100;
        const clickY = (clientY - rect.top) / rect.height * 100;
        // Clamp off-canvas releases to the canvas edge instead of dropping
        // them — the server needs every release to close out presses
        // (drag-end / offClick), even ones that finish outside the canvas.
        const x = Math.min(99.99, Math.max(0, clickX));
        const y = Math.min(99.99, Math.max(0, clickY));
        // Preserve the last movement even when the whole drag happened between
        // animation frames or inside the 30ms repeat throttle.
        const origin = this._pressOrigin;
        if (!cancelled && origin && this._pressClickSent && !this._hasPointerLock() &&
            (Math.abs(clientX - origin[0]) > .5 || Math.abs(clientY - origin[1]) > .5)) {
            this._sendMouseMove(clientX, clientY);
        }
        this._pressOrigin = null;
        // End the press on blur/touchcancel without committing a drag-and-drop.
        this.send(JSON.stringify({ type: 'mouseup', data: { x, y, ...(cancelled ? { cancelled: true } : {}) } }));
    }

    // Whether the game's squish version uses the single-click contract
    // (onClick once per press, mousemove while held, mouseup on release).
    // Modern version strings are three digits ('150', '144'); anything else
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
        // A pointer can move before the first animation frame. Its press still
        // belongs to the original object, not whichever object it moved over.
        const latest = this.mousePos;
        if (this._pressOrigin) {
            this.mousePos = this._pressOrigin.slice();
            clickInfo = this._canClick(this.mousePos[0], this.mousePos[1]);
        }
        this._handleClick(clickInfo, true);
        if (this._attached) this.mousePos = latest;
    }

    _promptTextInput(nodeId) {
        if (this._textDialog) return;
        const dialog = document.createElement('dialog'), form = document.createElement('div');
        const label = document.createElement('label'), input = document.createElement('input');
        const save = document.createElement('button'), cancel = document.createElement('button');
        dialog.setAttribute('aria-label', 'Input text');
        dialog.style.cssText = 'max-width:90vw;padding:24px;border-radius:12px;background:#101820;color:white;font:16px system-ui';
        label.textContent = 'Input text'; input.type = 'text'; input.maxLength = 4096;
        input.style.cssText = 'display:block;width:min(300px,65vw);padding:10px;margin:12px 0;font:inherit';
        label.append(input); save.textContent = 'Done'; save.type = 'button'; cancel.textContent = 'Cancel'; cancel.type = 'button';
        for (const button of [save,cancel]) button.style.cssText = 'padding:8px 16px;margin-right:8px;font:inherit';
        const close = () => { dialog.close(); dialog.remove(); this._textDialog = null; };
        save.onclick = event => { event.preventDefault(); const value = input.value; close(); this.send(JSON.stringify({type:'input',input:value,nodeId})); };
        input.onkeydown = event => { if (event.key === 'Enter') save.onclick(event); };
        cancel.onclick = close; dialog.oncancel = event => { event.preventDefault(); close(); };
        form.append(label,save,cancel); dialog.append(form); document.body.append(dialog);
        this._textDialog = dialog; dialog.showModal(); input.focus();
    }

    _handleClick(clickInfo, isNewPress) {
        if (!this.mousePos) return;

        if (clickInfo.action) {
            if (clickInfo.action === 'text') {
                this.mouseDown = false;
                this._promptTextInput(clickInfo.nodeId);
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
        // Games also import portable creations such as level packs. The node
        // has no per-input accept field; each game still validates the bytes.
        inputEl.accept = 'image/*,audio/*,video/*,application/json,.json';
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

    _translateX(x, rect = this.canvas.getBoundingClientRect()) {
        return (x * rect.width / 100) + rect.left;
    }

    _translateY(y, rect = this.canvas.getBoundingClientRect()) {
        return (y * rect.height / 100) + rect.top;
    }

    _canClick(x, y) {
        let isClickable = false;
        let isHoverable = false;
        let action = null;
        let nodeId = null;

        const rect = this.canvas.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return { isClickable, isHoverable, action, nodeId };

        // One geometry read covers the whole hit test, including every polygon
        // vertex. Keep pixel-space arithmetic and drawing-order occlusion.
        const thingIndices = this.getThingIndices();

        // The last containing node wins, including non-interactive shapes
        // that occlude controls. Search from the top so obscured lower nodes
        // need no geometry work once the same winner has been found.
        for (let chunkIndex = thingIndices.length - 1; chunkIndex >= 0; chunkIndex--) {
            const chunk = thingIndices[chunkIndex];
            if (!chunk) continue;
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
            let minX = this._translateX(vertices[0][0], rect);
            let maxX = minX;
            let minY = this._translateY(vertices[0][1], rect);
            let maxY = minY;

            for (let i = 1; i < vertices.length; i++) {
                const vx = this._translateX(vertices[i][0], rect);
                const vy = this._translateY(vertices[i][1], rect);
                if (vx < minX) minX = vx;
                if (vx > maxX) maxX = vx;
                if (vy < minY) minY = vy;
                if (vy > maxY) maxY = vy;
            }

            if (!(x < minX || x > maxX || y < minY || y > maxY)) {
                let i = 0, j = vertices.length - 1;
                for (; i < vertices.length; j = i++) {
                    const yi = this._translateY(vertices[i][1], rect);
                    const yj = this._translateY(vertices[j][1], rect);
                    const xi = this._translateX(vertices[i][0], rect);
                    const xj = this._translateX(vertices[j][0], rect);
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
                break;
            }
        }

        return { isClickable, isHoverable, action, nodeId };
    }
}

module.exports = InputHandler;
