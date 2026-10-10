// One playback per rendered node/view; the asset store owns the reusable bytes
// and Blob URL. Video frame callbacks invalidate the existing canvas loop.
class VideoPlayer {
    constructor(assetManager, asset, startTime, invalidate, opts = {}) {
        Object.assign(this, { assetManager, asset, invalidate, closed: false, frozen: false, forceMute: false });
        const video = this.element = document.createElement('video');
        video.playsInline = true; video.preload = 'auto'; video.muted = true;
        video.onloadedmetadata = () => {
            if (startTime > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(startTime, video.duration);
        };
        video.onloadeddata = video.onseeked = video.onended = () => { if (!this.closed) invalidate(); };
        video.onerror = () => { if (!this.closed) { this.error = true; invalidate(); } };
        if (asset.type === 'stream') video.srcObject = asset.data;
        else {
            if (!asset.url) asset.url = URL.createObjectURL(asset.data);
            video.src = asset.url;
        }
        assetManager.mediaPlayers.add(this);
        this.update(!!opts.muteAudio, !!opts.freezeMedia);
    }
    update(muteAudio, freezeMedia) {
        this.forceMute = muteAudio;
        if (freezeMedia) { this.frozen = true; this.element.pause(); return; }
        const resume = this.frozen; this.frozen = false;
        this.element.muted = muteAudio || !this.assetManager.mediaUnlocked || !!this.blockedAudio;
        if (!this.started || resume) this.play();
    }
    play() {
        if (this.closed || this.frozen || this.error || this.starting || this.element.ended) return;
        this.starting = true; this.started = true;
        const muted = this.element.muted;
        Promise.resolve(this.element.play()).then(() => {
            if (this.closed) return;
            this.starting = false; this.scheduleFrame(); this.invalidate();
        }).catch(error => {
            if (this.closed) return;
            this.starting = false;
            if (error.name === 'NotAllowedError') {
                this.blockedAudio = true;
                if (!muted && !this.frozen) { this.element.muted = true; this.play(); }
            } else if (error.name !== 'AbortError') this.error = true;
            this.invalidate();
        });
    }
    // Called synchronously by the existing input gesture/audio-unlock path.
    unlock() {
        if (this.closed || this.frozen || this.forceMute || this.element.ended) return;
        this.blockedAudio = false; this.element.muted = false; this.play();
    }
    scheduleFrame() {
        if (this.closed || this.frameCallback != null || !this.element.requestVideoFrameCallback) return;
        this.frameCallback = this.element.requestVideoFrameCallback(() => {
            this.frameCallback = null;
            if (this.closed) return;
            this.invalidate();
            if (!this.element.paused && !this.element.ended) this.scheduleFrame();
        });
    }
    needsRepaint() {
        return !this.closed && !this.frozen && !this.error && !this.element.requestVideoFrameCallback
            && !this.element.paused && !this.element.ended && this.element.readyState >= 2;
    }
    destroy() {
        if (this.closed) return;
        this.closed = true;
        if (this.frameCallback != null) this.element.cancelVideoFrameCallback?.(this.frameCallback);
        this.element.onloadedmetadata = this.element.onloadeddata = this.element.onseeked = this.element.onended = this.element.onerror = null;
        this.element.pause(); this.element.srcObject = null; this.element.removeAttribute('src'); this.element.load();
        this.assetManager.mediaPlayers.delete(this);
    }
}
module.exports = VideoPlayer;
