const RtcChannel = require('./rtc-channel');

const signalUrl = value => {
    const url = new URL(value, window.location.href);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling URL');
    return url.href;
};

function connectSignal(url, hello, onMessage, onEnd) {
    const ws = new WebSocket(signalUrl(url));
    let ended = false;
    const end = error => {
        if (ended) return;
        ended = true; clearTimeout(timer);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close(); onEnd(error);
    };
    const timer = setTimeout(() => end(new Error('Signaling connection timed out')), 15000);
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = event => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'error') return end(new Error(msg.message));
            if (msg.type === 'ended') return end(new Error('The host ended this game'));
            clearTimeout(timer); onMessage(msg);
        } catch (err) { end(err); }
    };
    ws.onerror = () => end(new Error('Cannot reach the invitation service'));
    ws.onclose = () => end(new Error('The invitation connection closed'));
    return {
        send: msg => { if (!ended && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
        close: () => end(null),
    };
}

class Peer {
    constructor({ iceServers, sendSignal, onOpen, onMessage, onEnd, host = false, iceTransportPolicy = 'all' }) {
        this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
        Object.assign(this, { sendSignal, onEnd });
        this.pendingCandidates = []; this.work = Promise.resolve(); this.closed = false;
        this.timer = setTimeout(() => this.close(new Error('Could not connect to the other device. Check the network or TURN configuration.')), 30000);
        this.pc.onicecandidate = event => { if (event.candidate) sendSignal({ candidate: event.candidate.toJSON() }); };
        this.pc.onconnectionstatechange = () => {
            if (this.pc.connectionState === 'failed') this.close(new Error('The game connection failed'));
            clearTimeout(this.disconnectTimer);
            if (this.pc.connectionState === 'disconnected') {
                this.disconnectTimer = setTimeout(() => this.close(new Error('The other device disconnected')), 10000);
            }
        };
        const bind = channel => {
            if (this.closed || this.channel) { channel.close(); return; }
            this.channel = new RtcChannel(channel, {
                onMessage, onError: err => this.close(err), onClose: () => this.close(),
            });
            channel.onopen = () => {
                if (this.closed) return;
                clearTimeout(this.timer); this.channel.flush(); onOpen(this.channel);
            };
        };
        if (host) bind(this.pc.createDataChannel('homegames', { ordered: true }));
        else this.pc.ondatachannel = event => bind(event.channel);
    }
    offer() {
        this.enqueue(async () => {
            const offer = await this.pc.createOffer();
            if (this.closed) return;
            await this.pc.setLocalDescription(offer);
            if (!this.closed) this.sendSignal({ description: this.pc.localDescription.toJSON() });
        });
    }
    signal(msg) {
        this.enqueue(async () => {
            if (msg.description) {
                await this.pc.setRemoteDescription(msg.description);
                if (this.closed) return;
                for (const candidate of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(candidate);
                if (msg.description.type === 'offer') {
                    const answer = await this.pc.createAnswer();
                    if (this.closed) return;
                    await this.pc.setLocalDescription(answer);
                    if (!this.closed) this.sendSignal({ description: this.pc.localDescription.toJSON() });
                }
            } else if (msg.candidate) {
                if (this.pc.remoteDescription) await this.pc.addIceCandidate(msg.candidate);
                else if (this.pendingCandidates.length < 128) this.pendingCandidates.push(msg.candidate);
                else throw new Error('Too many ICE candidates');
            }
        });
    }
    enqueue(fn) {
        this.work = this.work.then(() => { if (!this.closed) return fn(); }).catch(err => this.close(err));
    }
    close(error) {
        if (this.closed) return;
        this.closed = true; clearTimeout(this.timer); clearTimeout(this.disconnectTimer);
        this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
        this.channel?.close(); this.pc.close(); this.onEnd(error);
    }
}

class RtcHost {
    constructor(session, { signalingUrl = 'wss://api.homegames.io/rtc', joinUrl = 'https://homegames.io/play.html',
        onStatus = () => {}, iceTransportPolicy = 'all', room = null, visibility = 'private',
        onRoom = () => {}, onHeartbeat = () => {}, onEnd = () => {} } = {}) {
        Object.assign(this, { session, signalingUrl, joinUrl, onStatus, iceTransportPolicy, room, visibility, onRoom, onHeartbeat, onEnd });
        this.peers = new Map(); this.link = null; this.pending = null; this.signal = null;
        session.onStop = () => this.stop();
    }
    share() {
        if (this.link) return Promise.resolve(this.link);
        if (this.pending) return this.pending;
        if (!this.session.game) return Promise.reject(new Error('The game is still loading'));
        if (typeof RTCPeerConnection === 'undefined') return Promise.reject(new Error('This browser does not support WebRTC'));
        this.pending = new Promise((resolve, reject) => {
            this.reject = reject;
            this.signal = connectSignal(this.signalingUrl, { type: 'create', game: this.room,
                visibility: this.visibility, maxPlayers: this.session.maxPlayers }, msg => {
                if (msg.type === 'created') {
                    if (this.room && msg.protocol !== 2) throw new Error('The invitation service needs an update for public sessions');
                    this.supportsHeartbeat = msg.protocol === 2;
                    const url = new URL(this.joinUrl, window.location.href);
                    url.hash = new URLSearchParams({ room: msg.roomId, invite: msg.invite, signal: signalUrl(this.signalingUrl) }).toString();
                    this.link = url.href; this.reject = null;
                    this.onRoom(this.link);
                    this.visibility = msg.visibility || this.visibility;
                    if (msg.heartbeatIntervalMs) {
                        this.heartbeatTimer = setInterval(() => this.heartbeat(), msg.heartbeatIntervalMs);
                        this.heartbeat();
                    }
                    this.status(); resolve(this.link);
                } else if (msg.type === 'peer-joined') this.addPeer(msg);
                else if (msg.type === 'peer-left') this.peers.get(msg.peerId)?.close();
                else if (msg.type === 'signal') this.peers.get(msg.peerId)?.signal(msg);
                else if (msg.type === 'visibility') {
                    this.visibility = msg.visibility; this.status();
                    const pending = this.visibilityPending; this.visibilityPending = null;
                    if (pending) { clearTimeout(pending.timer); pending.resolve(msg.visibility); }
                }
            }, error => { this.stop(error); if (error) this.onStatus(error.message); });
        });
        return this.pending.catch(err => { this.pending = null; throw err; });
    }
    heartbeat() {
        const playerCount = Math.min(17, this.session.players?.length || 1);
        if (this.supportsHeartbeat) this.signal?.send({ type: 'heartbeat', playerCount });
        if (this.link) this.onHeartbeat(playerCount);
    }
    status() {
        const players = this.session.players?.length || 1;
        this.onStatus(this.room
            ? `${this.visibility === 'public' ? 'Public' : 'Private'} game · ${players} ${players === 1 ? 'player' : 'players'}`
            : players > 1 ? `${players} players connected` : 'Waiting for a player');
    }
    async setVisibility(visibility) {
        await this.share();
        if (!this.room) throw new Error('Only catalog games can be listed publicly');
        if (this.visibilityPending) throw new Error('Visibility is still updating');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.visibilityPending = null; reject(new Error('Unable to update visibility'));
            }, 10000);
            this.visibilityPending = { resolve, reject, timer };
            this.signal.send({ type: 'visibility', visibility });
        });
    }
    addPeer({ peerId, iceServers }) {
        let seat = null;
        let windowAt = Date.now(), count = 0;
        const peer = new Peer({
            host: true, iceServers, iceTransportPolicy: this.iceTransportPolicy,
            sendSignal: data => this.signal?.send({ type: 'signal', peerId, ...data }),
            onOpen: () => {},
            onMessage: data => {
                try {
                    if (typeof data !== 'string') throw new Error('Expected player input');
                    if (Date.now() - windowAt > 1000) { windowAt = Date.now(); count = 0; }
                    if (++count > 240) throw new Error('Too much player input');
                    if (!seat) {
                        const ready = JSON.parse(data);
                        if (ready.type !== 'ready') throw new Error('Expected player handshake');
                        seat = this.session.addRemotePlayer({ send: bytes => peer.channel.send(bytes),
                            close: () => peer.close(), clientInfo: ready.clientInfo?.clientInfo || {} });
                        this.heartbeat(); this.status();
                    } else seat.handleMessage(data);
                } catch (err) { peer.close(err); }
            },
            onEnd: error => {
                this.peers.delete(peerId); seat?.leave();
                this.signal?.send({ type: 'remove', peerId });
                this.heartbeat();
                if (!seat && error) this.onStatus(error.message); else this.status();
            },
        });
        this.peers.set(peerId, peer); peer.offer();
    }
    stop(error = new Error('The invitation ended')) {
        if (this.link || this.pending) this.onEnd();
        clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
        this.supportsHeartbeat = false;
        const visibilityPending = this.visibilityPending; this.visibilityPending = null;
        if (visibilityPending) { clearTimeout(visibilityPending.timer); visibilityPending.reject(error || new Error('The invitation ended')); }
        // Reject with the original failure before closing the socket, whose
        // synchronous onEnd callback can re-enter stop().
        const reject = this.reject; this.reject = null;
        reject?.(error || new Error('The invitation ended'));
        const signal = this.signal; this.signal = null;
        signal?.close();
        for (const peer of [...this.peers.values()]) peer.close();
        this.peers.clear(); this.link = null; this.pending = null;
    }
}

// Transport factory for the existing HomegamesClient view/protocol lifecycle.
const createRtcTransport = ({ roomId, invite, signalingUrl, iceTransportPolicy = 'all' }) => callbacks => {
    let peer = null, closed = false, connected = false, signal;
    const end = error => {
        if (closed) return;
        closed = true; peer?.close(); signal?.close();
        if (error && !connected) callbacks.onError(error);
        callbacks.onClose();
    };
    try {
        signal = connectSignal(signalingUrl, { type: 'join', roomId, invite }, msg => {
            if (msg.type === 'joined') {
                peer = new Peer({ iceServers: msg.iceServers, iceTransportPolicy,
                    sendSignal: data => signal.send({ type: 'signal', ...data }),
                    onOpen: () => { connected = true; callbacks.onOpen(); }, onMessage: callbacks.onMessage, onEnd: end });
            } else if (msg.type === 'signal') peer?.signal(msg);
        }, end);
    } catch (err) { queueMicrotask(() => end(err)); }
    return { send: data => peer?.channel?.send(data), close: () => { closed = true; peer?.close(); signal?.close(); } };
};

const readInvitation = (hash = window.location.hash) => {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    if (!params.has('room')) return null;
    return { roomId: params.get('room'), invite: params.get('invite'), signalingUrl: params.get('signal') };
};

module.exports = { RtcHost, createRtcTransport, readInvitation };
