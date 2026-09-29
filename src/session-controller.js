// Own the active session and pending transition. Loading does not tear down
// the current game; committing a successful load does. Generation checks also
// cover embedders whose loader cannot physically abort its work.
class SessionController {
    constructor({ remote, loadLocal, mountLocal, createLocal, onError }) {
        Object.assign(this, { remote, loadLocal, mountLocal, createLocal, onError });
        this.local = null;
        this.chrome = null;
        this.generation = 0;
        this.pending = null;
    }

    _cancelLoad() {
        this.generation++;
        this.pending?.abort();
        this.pending = null;
    }

    _disposeActive() {
        const local = this.local;
        this.local = null;
        local?.stop();
        this.chrome?.dispose();
        this.chrome = null;
        this.remote.stop();
    }

    start() { this.stop(); this.remote.start(); }
    stop() { this._cancelLoad(); this._disposeActive(); }

    async startLocal(request) {
        this._cancelLoad();
        const generation = this.generation;
        const pending = this.pending = new AbortController();
        try {
            const game = await this.loadLocal(request, { signal: pending.signal });
            if (generation !== this.generation) return;
            this.pending = null;
            this._disposeActive();
            this.chrome = this.mountLocal(game);
            this.local = this.createLocal({ ...game, containerId: this.chrome.containerId });
            this.local.start();
        } catch (err) {
            if (generation !== this.generation) return;
            this.pending = null;
            this.onError(err);
        }
    }
}

module.exports = SessionController;
