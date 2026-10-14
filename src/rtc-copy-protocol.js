'use strict';

// A copy is an ordinary portable ZIP. Stop-and-wait limits each peer to one
// small outstanding chunk and keeps these packets separate from game frames.
const { LIMITS } = require('homegames-common/portable-project');
const CHUNK = 64 * 1024;
const MARKER = 0x50;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const message = data => {
    if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid game-copy message');
    const value = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid game-copy message');
    return value;
};
function offer(value) {
    if (value.type !== 'copy-offer' || value.protocol !== 1 || typeof value.name !== 'string' || !value.name.length || value.name.length > 200
        || !/^[a-f0-9]{64}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.sha256)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.gameId)
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > LIMITS.archiveBytes) throw new Error('Invalid or oversized game copy');
    return { type: 'copy-offer', protocol: 1, name: value.name, revision: value.revision, sha256: value.sha256, gameId: value.gameId, bytes: value.bytes };
}
class Sender {
    constructor(bytes, metadata, send, progress = () => {}) {
        this.bytes = bytes; this.send = send; this.progress = progress;
        this.metadata = offer(metadata); this.offset = 0; this.accepted = false; this.done = false;
        if (bytes.length !== metadata.bytes) throw new Error('Game-copy size changed');
    }
    open() { this.send(JSON.stringify(this.metadata)); }
    receive(data) {
        const msg = message(data);
        if (msg.type === 'copy-accept' && !this.accepted) { this.accepted = true; this.next(); return; }
        if (msg.type === 'copy-ack' && this.accepted && !this.done && msg.offset === this.offset) {
            this.progress(this.offset, this.bytes.length);
            if (this.offset === this.bytes.length) { this.done = true; this.send(JSON.stringify({ type: 'copy-complete' })); }
            else this.next();
            return;
        }
        if (msg.type === 'copy-saved' && this.done) return;
        throw new Error('Unexpected game-copy acknowledgement');
    }
    next() {
        const end = Math.min(this.offset + CHUNK, this.bytes.length), packet = new Uint8Array(5 + end - this.offset);
        packet[0] = MARKER; new DataView(packet.buffer).setUint32(1, this.offset);
        packet.set(this.bytes.subarray(this.offset, end), 5); this.offset = end; this.send(packet);
    }
}
class Receiver {
    constructor(send, { onOffer = () => {}, onProgress = () => {}, importArchive, onComplete }) {
        Object.assign(this, { send, onOffer, onProgress, importArchive, onComplete });
        this.metadata = null; this.bytes = null; this.offset = 0; this.state = 'offer';
    }
    accept() {
        if (this.state !== 'waiting') throw new Error('Wait for the game details before receiving');
        this.bytes = new Uint8Array(this.metadata.bytes); this.state = 'receiving';
        this.send(JSON.stringify({ type: 'copy-accept' }));
    }
    async receive(data) {
        if (this.state === 'closed') return;
        if (typeof data === 'string') {
            const msg = message(data);
            if (this.state === 'offer') {
                this.metadata = offer(msg); this.state = 'waiting'; this.onOffer(this.metadata); return;
            }
            if (msg.type !== 'copy-complete' || this.state !== 'receiving' || this.offset !== this.metadata.bytes) throw new Error('Incomplete game copy');
            this.state = 'validating';
            const bytes = this.bytes, metadata = this.metadata;
            if (await digest(bytes) !== metadata.sha256) throw new Error('The game copy was damaged during transfer. Try again.');
            const project = await this.importArchive(bytes);
            if (project.revision !== metadata.revision || project.manifest.gameId !== metadata.gameId) throw new Error('The received game does not match the offered copy');
            if (this.state === 'closed') return;
            await this.onComplete({ bytes, project });
            if (this.state === 'closed') return;
            this.state = 'done'; this.bytes = null; this.send(JSON.stringify({ type: 'copy-saved' }));
            return;
        }
        if (this.state !== 'receiving') throw new Error('Unexpected game-copy data');
        const packet = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const length = Math.min(CHUNK, this.metadata.bytes - this.offset);
        if (!(packet instanceof Uint8Array) || packet.length !== length + 5 || !length || packet[0] !== MARKER
            || new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1) !== this.offset) throw new Error('Invalid game-copy chunk');
        this.bytes.set(packet.subarray(5), this.offset); this.offset += length;
        this.onProgress(this.offset, this.metadata.bytes);
        this.send(JSON.stringify({ type: 'copy-ack', offset: this.offset }));
    }
    close() { this.state = 'closed'; this.bytes = null; }
}
module.exports = { Sender, Receiver, digest, offer, CHUNK };
