const { recordAudio } = require('homegames-common/portable-client');
const { recordVideo } = require('homegames-common/video-recording');

// A recording is a device-owned consent flow, returning one completed file.
// Sandboxed players use the same UI through the explicit trusted adapter.
class RecordingClient {
    constructor({ send, busy, platform }) { Object.assign(this, { send, busy, platform }); }
    request(info) {
        if (!info || typeof info.id !== 'string' || this.closed) return;
        if (this.active || this.busy()) {
            this.send({ type:'media', action:'record-result', id:info.id, error:'A microphone/camera is already active' }); return;
        }
        const method = info.kind === 'audio' ? 'recordAudio' : 'recordVideo';
        const handle = this.active = this.platform?.[method]
            ? { result:this.platform[method](info), close:()=>this.platform.cancelRecording?.(info.id) }
            : (info.kind === 'audio' ? recordAudio : recordVideo)(window, info);
        handle.id = info.id;
        handle.result.then(value => {
            if (this.active !== handle) return;
            this.active = null; if (!this.closed) this.send(value);
        }, error => {
            if (this.active !== handle) return;
            this.active = null; if (!this.closed) this.send({ type:'media', action:'record-result', id:info.id, error:error.message });
        });
    }
    cancel(id) { if (this.active && this.active.id === id) { const handle = this.active; this.active = null; handle.close(); } }
    destroy() { this.closed = true; this.cancel(this.active?.id); }
}
module.exports = RecordingClient;
