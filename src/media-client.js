// Device-owned capture and stream lookup. Only an explicit platform consent
// button calls getUserMedia; game code receives handles, never capture objects.
const RecordingClient = require('./recording-client');
class MediaClient {
    constructor({ container, assets, send, platform, publish = () => {}, unpublish = () => {} }) {
        Object.assign(this, { container, assets, send, publish, unpublish });
        this.streams = new Map(); this.received = new Map(); this.pending = new Map(); this.held = new Set();
        this.recorder = new RecordingClient({ container, send, platform,
            busy: () => this.pending.size || [...this.streams.values()].some(a => a.local) });
        assets.liveMedia = this;
        this.releaseAll = () => this.release();
        this.visibility = () => { if (document.hidden) this.release(); };
        window.addEventListener('blur', this.releaseAll);
        document.addEventListener('visibilitychange', this.visibility);
    }
    hold(key) { this.held.add(key); }
    release(key) {
        if (key) this.held.delete(key); else this.held.clear();
        if (this.held.size) return;
        for (const asset of this.streams.values()) if (asset.local && asset.pushToTalk) {
            asset.transmitting = false; asset.data.getTracks().forEach(track => { track.enabled = false; });
            this.send({ type: 'media', action: 'released', id: asset.id });
        }
        this.assets._notifyReady();
    }
    receive(message) {
        if (this.closed) return;
        if (message.action === 'record') return this.recorder.request(message.recording);
        if (message.action === 'record-cancel') return this.recorder.cancel(message.id);
        if (message.action === 'request') return this.request(message.stream);
        if (message.action === 'ended') return this.remove(message.id);
        if (['available', 'state'].includes(message.action)) {
            const info = message.stream;
            if (!info || typeof info.id !== 'string') return;
            const existing = this.streams.get(info.id);
            if (existing) {
                Object.assign(existing, info);
                if (existing.local) {
                    if (info.pushToTalk && !this.held.size && info.transmitting) {
                        existing.transmitting = false;
                        this.send({ type: 'media', action: 'released', id: info.id });
                    }
                    existing.data.getTracks().forEach(track => { track.enabled = existing.transmitting; });
                }
            } else this.streams.set(info.id, { ...info, type: 'stream', data: this.received.get(info.sourceId), local: false });
            this.assets._notifyReady();
        }
    }
    attach(stream) {
        this.received.set(stream.id, stream);
        for (const asset of this.streams.values()) if (!asset.local && asset.sourceId === stream.id) asset.data = stream;
        this.assets._notifyReady();
    }
    request(info) {
        if (!info || this.pending.has(info.id)) return;
        if (this.recorder.active || this.pending.size || [...this.streams.values()].some(a => a.local)) {
            this.send({ type: 'media', action: 'result', id: info.id, error: 'A microphone/camera is already active or awaiting permission' }); return;
        }
        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-label', 'Enable live media');
        dialog.style.cssText = 'margin:auto;padding:24px;max-width:360px;border:1px solid #666;border-radius:16px;background:#202321;color:white;font:16px system-ui';
        const label = document.createElement('p'); label.textContent = info.video ? `Share your camera${info.audio ? ' and microphone' : ''} with this session?` : 'Enable your microphone for this session?';
        const start = document.createElement('button'); start.textContent = info.video ? 'Enable camera' : 'Enable microphone';
        const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
        for (const button of [start, cancel]) button.style.cssText = 'padding:12px;margin:16px 8px 0 0;font:inherit';
        dialog.append(label, start, cancel); this.container.appendChild(dialog);
        this.pending.set(info.id, dialog);
        const fail = message => { this.remove(info.id); this.send({ type: 'media', action: 'result', id: info.id, error: message }); };
        dialog.oncancel = event => { event.preventDefault(); fail('Microphone/camera permission cancelled'); };
        cancel.onclick = () => fail('Microphone/camera permission cancelled');
        start.onclick = async () => {
            start.disabled = true;
            try {
                this.assets.unlockAudio?.();
                if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone/camera requires HTTPS or localhost');
                const stream = await navigator.mediaDevices.getUserMedia({ audio: info.audio ? { echoCancellation: true, noiseSuppression: true } : false,
                    video: info.video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 30 } } : false });
                if (this.closed || !this.pending.has(info.id)) { stream.getTracks().forEach(track => track.stop()); return; }
                this.pending.delete(info.id); dialog.close(); dialog.remove();
                const asset = { ...info, sourceId: stream.id, type: 'stream', data: stream, local: true,
                    transmitting: info.transmitting && (!info.pushToTalk || this.held.size > 0) };
                this.streams.set(info.id, asset);
                stream.getTracks().forEach(track => { track.enabled = !!asset.transmitting; track.onended = () => this.stopLocal(info.id); });
                this.send({ type: 'media', action: 'result', id: info.id, sourceId: stream.id });
                this.publish(info.id, stream); this.showStop(); this.assets._notifyReady();
                // Only physical push-to-talk release can override a later
                // host transmit command. A paused, toggle-based capture is
                // already paused; sending 'released' races its enable reply.
                if (asset.pushToTalk && !asset.transmitting) this.send({ type: 'media', action: 'released', id: info.id });
            } catch (error) { if (this.pending.has(info.id)) fail(error.message || 'Unable to access microphone/camera'); }
        };
        dialog.showModal(); start.focus();
    }
    showStop() {
        if (this.stopButton) return;
        const button = this.stopButton = document.createElement('button');
        button.textContent = 'Disconnect microphone / camera';
        button.style.cssText = 'position:absolute;right:12px;bottom:12px;padding:10px;border:1px solid #fff;border-radius:8px;background:#8b2525;color:white;z-index:10;font:13px system-ui';
        button.onclick = () => { for (const asset of [...this.streams.values()]) if (asset.local) this.stopLocal(asset.id); };
        this.container.appendChild(button);
    }
    stopLocal(id) { this.remove(id); this.send({ type: 'media', action: 'stopped', id }); }
    remove(id) {
        const dialog = this.pending.get(id);
        if (dialog) { this.pending.delete(id); dialog.close(); dialog.remove(); }
        const asset = this.streams.get(id); this.streams.delete(id);
        if (asset?.local) {
            this.unpublish(id);
            asset.data.getTracks().forEach(track => { track.onended = null; track.stop(); });
            this.stopButton?.remove(); this.stopButton = null;
        }
        if (asset) this.received.delete(asset.sourceId);
        this.assets._notifyReady();
    }
    destroy() {
        if (this.closed) return;
        this.closed = true;
        this.recorder.destroy();
        for (const id of [...this.pending.keys(), ...this.streams.keys()]) this.remove(id);
        this.received.clear(); this.held.clear();
        window.removeEventListener('blur', this.releaseAll); document.removeEventListener('visibilitychange', this.visibility);
        if (this.assets.liveMedia === this) this.assets.liveMedia = null;
    }
}
module.exports = MediaClient;
