// Reliable, ordered application packets over bounded 16 KiB SCTP messages.
// Assets can be much larger than a browser's single-message limit. Keep one
// latest queued snapshot per peer so slow guests cannot stall the host.
function channelModule() {
const CHUNK = 16 * 1024;
const MAX_PACKET = 10 * 1024 * 1024;
const MAX_QUEUE = 20 * 1024 * 1024;
class RtcChannel {
    constructor(channel, { onMessage, onClose = () => {}, onError = () => {} }) {
        Object.assign(this, { channel, onMessage, onClose, onError });
        this.queue = []; this.queuedBytes = 0; this.pending = null; this.closed = false;
        this.stats = { sentPackets: 0, receivedPackets: 0, wireMessages: 0, wireBytes: 0, duplicateFrames: 0, replacedFrames: 0, maxBufferedBytes: 0 };
        this.lastFrame = null;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = 16 * 1024;
        channel.onbufferedamountlow = () => this.flush();
        channel.onmessage = event => {
            try { this.receive(event.data); } catch (err) { this.fail(err); }
        };
        channel.onclose = () => this.close();
        channel.onerror = () => this.fail(new Error('Game connection failed'));
    }
    send(data) {
        if (this.closed) return;
        const text = typeof data === 'string';
        const bytes = text ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (!bytes.length || bytes.length > MAX_PACKET) return this.fail(new Error('Game packet is too large'));
        const frame = !text && bytes[0] === 3;
        if (frame) {
            if (this.lastFrame && bytes.length === this.lastFrame.length && bytes.every((value, i) => value === this.lastFrame[i])) {
                this.stats.duplicateFrames++; return;
            }
            this.lastFrame = bytes;
            this.queue = this.queue.filter(p => {
                if (p.frame && p.offset === null) { this.queuedBytes -= p.bytes.length; this.stats.replacedFrames++; return false; }
                return true;
            });
        }
        if (this.queuedBytes + bytes.length > MAX_QUEUE) return this.fail(new Error('Guest connection is too slow'));
        this.queue.push({ bytes, text, frame, offset: null }); this.queuedBytes += bytes.length;
        this.flush();
    }
    flush() {
        try {
            while (!this.closed && this.channel.readyState === 'open' && this.queue.length
                && this.channel.bufferedAmount < 64 * 1024) {
                const packet = this.queue[0];
                if (packet.offset === null) {
                    this.write(JSON.stringify({ bytes: packet.bytes.length, text: packet.text }));
                    packet.offset = 0;
                }
                this.write(packet.bytes.subarray(packet.offset, packet.offset + CHUNK));
                packet.offset += CHUNK;
                if (packet.offset >= packet.bytes.length) {
                    this.queue.shift(); this.queuedBytes -= packet.bytes.length; this.stats.sentPackets++;
                }
            }
        } catch (err) { this.fail(err); }
    }
    write(data) {
        this.channel.send(data);
        this.stats.wireMessages++;
        this.stats.wireBytes += typeof data === 'string' ? data.length : data.byteLength;
        this.stats.maxBufferedBytes = Math.max(this.stats.maxBufferedBytes, this.channel.bufferedAmount);
    }
    receive(data) {
        if (this.closed) return;
        if (typeof data === 'string') {
            const header = JSON.parse(data);
            if (this.pending || !Number.isInteger(header.bytes) || header.bytes < 1 || header.bytes > MAX_PACKET
                || typeof header.text !== 'boolean') throw new Error('Invalid game packet');
            this.pending = { bytes: new Uint8Array(header.bytes), text: header.text, offset: 0 };
            this.receiveTimer = setTimeout(() => this.fail(new Error('Game packet timed out')), 30000);
            return;
        }
        const packet = this.pending;
        if (!(data instanceof ArrayBuffer) || !packet || !data.byteLength || data.byteLength > CHUNK
            || packet.offset + data.byteLength > packet.bytes.length) throw new Error('Invalid game packet');
        packet.bytes.set(new Uint8Array(data), packet.offset); packet.offset += data.byteLength;
        if (packet.offset === packet.bytes.length) {
            clearTimeout(this.receiveTimer); this.pending = null; this.stats.receivedPackets++;
            this.onMessage(packet.text ? new TextDecoder().decode(packet.bytes) : packet.bytes.buffer);
        }
    }
    fail(err) { if (!this.closed) { this.onError(err); this.close(); } }
    close() {
        if (this.closed) return;
        this.closed = true; clearTimeout(this.receiveTimer);
        this.queue = []; this.pending = null; this.queuedBytes = 0; this.lastFrame = null;
        this.channel.onmessage = this.channel.onclose = this.channel.onerror = this.channel.onbufferedamountlow = null;
        this.channel.close(); this.onClose();
    }
}
// One packet in flight across a worker boundary, plus a bounded queue. Only
// unsent snapshots can be superseded; assets and input remain ordered/lossless.
RtcChannel.Mailbox = class {
    constructor(deliver, fail) {
        Object.assign(this, { deliver, fail });
        this.queue = []; this.bytes = 0; this.waiting = false; this.closed = false; this.replacedFrames = 0;
    }
    send(data, transfer = false) {
        if (this.closed) return;
        const text = typeof data === 'string';
        const bytes = text ? null : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const frame = bytes?.[0] === 3;
        if (frame) this.queue = this.queue.filter(packet => {
            if (packet.frame) { this.bytes -= packet.size; this.replacedFrames++; return false; }
            return true;
        });
        const size = text ? data.length * 2 : bytes.byteLength;
        if (this.bytes + size > MAX_QUEUE) { this.fail(new Error('Game message queue is full')); return; }
        this.queue.push({ data, transfer, frame, size }); this.bytes += size; this.pump();
    }
    pump() {
        if (this.closed || this.waiting || !this.queue.length) return;
        const packet = this.queue.shift(); this.bytes -= packet.size; this.waiting = true;
        try { this.deliver(packet.data, packet.transfer); } catch (err) { this.fail(err); }
    }
    ack() { this.waiting = false; this.pump(); }
    close() { this.closed = true; this.queue = []; this.bytes = 0; }
};
return RtcChannel;
}
const RtcChannel = channelModule();
// Inline the dependency-free worker runtime so downloaded HTML needs no worker
// URL, external scripts, or additional deployment files.
RtcChannel.workerSource = () => `(${channelModule.toString()})()`;
module.exports = RtcChannel;
