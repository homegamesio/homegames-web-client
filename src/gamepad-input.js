const { Homepad, mapGamepad } = require('homepad');
const standard = require('homepad/gamepad-mappings/standard');

// Homegames owns delivery cadence and player routing. Homepad only reads/maps.
class GamepadInput {
    constructor(send, options = {}) {
        this.send = send;
        this.index = options.index ?? null; // null: all controllers for this player
        this.homepad = new Homepad(options);
        this.onError = options.onError || (error => console.warn('Gamepad input:', error));
        this.previous = new Map();
        this.nextPoll = 0;
        this.lastPoll = null;
        this.errorMessage = null;
    }

    tick(now = Date.now()) {
        if (now + 0.001 < this.nextPoll) return;
        const deltaTime = this.lastPoll === null ? 1 / 30 : Math.min(0.1, Math.max(0, (now - this.lastPoll) / 1000));
        this.lastPoll = now;
        let pads;
        try {
            pads = this.homepad.getGamepads().filter(pad => this.index === null || pad.index === this.index);
            if (this.homepad.error) throw this.homepad.error;
            this.errorMessage = null;
        } catch (error) {
            this.release();
            if (this.errorMessage !== error.message) this.onError(error);
            this.errorMessage = error.message;
            return;
        }
        // Keep headroom under the server's 120 messages/sec limit, including
        // when several controllers belong to one player.
        const interval = Math.max(1000 / 30, pads.length * 1000 / 60);
        const elapsed = Math.max(0, now - this.nextPoll);
        this.nextPoll = now + interval - (elapsed % interval);
        const current = new Map(pads.map(pad => [pad.index, pad]));
        for (const [index, previous] of this.previous) {
            if (!current.has(index) || current.get(index).id !== previous.id) this._release(previous);
        }
        for (const pad of pads) {
            // Held input is deliberately repeated, even if its value is unchanged.
            this.send(JSON.stringify({ type: 'input', gamepad: true, gamepadIndex: pad.index,
                connected: true, deltaTime, input: pad.state }));
        }
        this.previous = current;
    }

    _release(pad) {
        this.send(JSON.stringify({ type: 'input', gamepad: true, gamepadIndex: pad.index,
            connected: false, deltaTime: 0, input: mapGamepad({ buttons: [], axes: [] }, standard) }));
    }

    release() {
        for (const pad of this.previous.values()) this._release(pad);
        this.previous.clear();
        this.nextPoll = 0;
        this.lastPoll = null;
    }

    setIndex(index) {
        this.release();
        this.index = index;
    }
}

module.exports = GamepadInput;
