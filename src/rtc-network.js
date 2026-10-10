const RtcChannel = require('./rtc-channel');
const connectSignal = require('./rtc-signaling-client');
const rtcWorker = require('./rtc-worker');

// One worker per active host/guest session, shared by signaling and ALL peers.
// RTCPeerConnection negotiation stays on Window; transfer each data channel
// immediately at creation/ondatachannel, before the transfer window expires.
class RtcNetwork {
    constructor({ worker = true } = {}) {
        this.channels = new Map(); this.nextId = 0; this.statsRequests = new Map(); this.closed = false;
        this.worker = null;
        if (worker && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
                this.workerUrl = URL.createObjectURL(new Blob([
                    `(${rtcWorker.toString()})(${RtcChannel.workerSource()},${connectSignal.toString()});`,
                ], { type: 'text/javascript' }));
                this.worker = new Worker(this.workerUrl, { name: 'homegames-rtc' });
                this.worker.onmessage = event => this.receive(event.data);
                this.worker.onerror = event => {
                    event.preventDefault?.();
                    const error = new Error(event.message || 'RTC communication worker failed');
                    this.onSignalEnd?.(error);
                    for (const entry of [...this.channels.values()]) entry.callbacks.onError(error);
                    this.close();
                };
            } catch (_) {
                this.worker?.terminate(); this.worker = null;
                if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
                this.workerUrl = null;
            }
        }
    }
    signal(url, hello, onMessage, onEnd, onHeartbeat) {
        this.onSignalMessage = onMessage; this.onSignalEnd = onEnd; this.onHeartbeat = onHeartbeat;
        if (!this.worker) return this.inlineSignal = connectSignal(url, hello, onMessage, onEnd, onHeartbeat);
        const post = (type, data = {}) => { if (!this.closed) this.worker.postMessage({ type, ...data }); };
        post('signal-open', { url, hello });
        return {
            send: data => post('signal-send', { data }),
            startHeartbeat: (interval, data) => post('heartbeat-start', { interval, data }),
            heartbeat: data => post('heartbeat-update', { data }),
            close: () => { this.onSignalEnd = null; post('signal-close'); },
        };
    }
    bind(channel, callbacks) {
        const id = ++this.nextId;
        const entry = { callbacks, mode: 'main-thread', protocol: null, mailbox: null };
        this.channels.set(id, entry);
        if (this.worker) {
            try {
                this.worker.postMessage({ type: 'bind', id, channel }, [channel]);
                entry.mode = 'worker';
            } catch (_) { /* Older browsers keep this channel on Window. */ }
        }
        if (entry.mode === 'worker') {
            entry.mailbox = new RtcChannel.Mailbox((data, transfer) => {
                this.worker.postMessage({ type: 'send', id, data },
                    transfer && typeof data !== 'string' ? [data.buffer || data] : []);
            }, error => callbacks.onError(error));
        } else {
            entry.protocol = new RtcChannel(channel, callbacks);
            let opened = false;
            const open = () => {
                if (opened || entry.protocol.closed || this.closed) return;
                opened = true; entry.protocol.flush(); callbacks.onOpen();
            };
            channel.onopen = open;
            if (channel.readyState === 'open') queueMicrotask(open);
        }
        return {
            send: (data, { transfer = false } = {}) => {
                if (this.closed || !this.channels.has(id)) return;
                if (entry.mailbox) entry.mailbox.send(data, transfer);
                else entry.protocol.send(data);
            },
            close: () => {
                if (!this.channels.delete(id)) return;
                entry.mailbox?.close(); entry.protocol?.close();
                if (entry.mode === 'worker' && !this.closed) this.worker.postMessage({ type: 'channel-close', id });
            },
        };
    }
    receive(message) {
        if (this.closed) return;
        const entry = this.channels.get(message.id);
        switch (message.type) {
            case 'signal-message':
                try { this.onSignalMessage?.(message.data); }
                catch (error) { this.onSignalEnd?.(error); }
                break;
            case 'signal-end': this.onSignalEnd?.(message.message ? new Error(message.message) : null); break;
            case 'heartbeat': this.onHeartbeat?.(message.data); break;
            case 'channel-open': entry?.callbacks.onOpen(); break;
            case 'channel-error': entry?.callbacks.onError(new Error(message.message)); break;
            case 'channel-close': entry?.callbacks.onClose(); break;
            case 'sent': entry?.mailbox.ack(); break;
            case 'data':
                try { entry?.callbacks.onMessage(message.data); }
                catch (error) { entry?.callbacks.onError(error); }
                if (!this.closed) this.worker.postMessage({ type: 'received', id: message.id });
                break;
            case 'stats': {
                const request = this.statsRequests.get(message.id);
                if (request) { clearTimeout(request.timer); this.statsRequests.delete(message.id); request.resolve(message.channels); }
                break;
            }
        }
    }
    async getStats() {
        const inline = [...this.channels].filter(([, entry]) => entry.protocol).map(([id, entry]) => ({
            id, mode: entry.mode, ...entry.protocol.stats, queuedBytes: entry.protocol.queuedBytes,
            bufferedBytes: entry.protocol.channel.bufferedAmount,
        }));
        let channels = [];
        if (this.worker && !this.closed) channels = await new Promise(resolve => {
            const id = ++this.nextId;
            const timer = setTimeout(() => { this.statsRequests.delete(id); resolve([]); }, 2000);
            this.statsRequests.set(id, { resolve, timer }); this.worker.postMessage({ type: 'stats', id });
        });
        return { worker: !!this.worker && !this.closed, channels: [...channels, ...inline].map(channel => ({ ...channel,
            sendQueueBytes: this.channels.get(channel.id)?.mailbox?.bytes || 0,
            sendReplacedFrames: this.channels.get(channel.id)?.mailbox?.replacedFrames || 0,
        })) };
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        for (const entry of this.channels.values()) { entry.mailbox?.close(); entry.protocol?.close(); }
        this.channels.clear(); this.inlineSignal?.close();
        this.worker?.terminate();
        if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
        this.statsRequests.forEach(request => { clearTimeout(request.timer); request.resolve([]); });
        this.statsRequests.clear();
    }
}
module.exports = RtcNetwork;
