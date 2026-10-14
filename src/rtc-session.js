const RtcNetwork = require('./rtc-network');

const signalUrl = value => {
    const url = new URL(value, window.location.href);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling URL');
    return url.href;
};


class Peer {
    constructor({ iceServers, sendSignal, onOpen, onMessage, onEnd, onTrack = () => {}, network, host = false, iceTransportPolicy = 'all' }) {
        this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
        Object.assign(this, { sendSignal, onEnd });
        this.pendingCandidates = []; this.work = Promise.resolve(); this.closed = false;
        this.polite = !host; this.senders = new Map(); this.receivedStreams = new Map();
        this.pc.onnegotiationneeded = () => this.offer();
        this.pc.ontrack = event => {
            const stream = event.streams[0];
            if (!stream) return;
            this.receivedStreams.set(stream.id, stream);
            if (this.receivedStreams.size > 32) this.receivedStreams.delete(this.receivedStreams.keys().next().value);
            onTrack(stream);
        };
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
            this.channel = network.bind(channel, {
                onMessage, onError: err => this.close(err), onClose: () => this.close(),
                onOpen: () => {
                    if (this.closed) return;
                    clearTimeout(this.timer); onOpen(this.channel);
                },
            });
        };
        if (host) bind(this.pc.createDataChannel('homegames', { ordered: true }));
        else this.pc.ondatachannel = event => bind(event.channel);
    }
    offer() {
        this.enqueue(async () => {
            if (this.pc.signalingState !== 'stable') return;
            this.makingOffer = true;
            try {
                await this.pc.setLocalDescription(await this.pc.createOffer());
                if (!this.closed) this.sendSignal({ description: this.pc.localDescription.toJSON() });
            } finally { this.makingOffer = false; }
        });
    }
    addMedia(id, stream) {
        const senders = this.senders.get(id) || [];
        for (const track of stream.getTracks()) if (!senders.some(sender => sender.track === track)) {
            senders.push(this.pc.addTrack(track, stream));
        }
        this.senders.set(id, senders);
    }
    removeMedia(id) {
        for (const sender of this.senders.get(id) || []) if (!this.closed) this.pc.removeTrack(sender);
        this.senders.delete(id);
    }
    signal(msg) {
        this.enqueue(async () => {
            if (msg.description) {
                const collision = msg.description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
                this.ignoreOffer = !this.polite && collision;
                if (this.ignoreOffer) return;
                // A polite guest rolls back a colliding local offer. Both sides
                // can add tracks while already connected (camera, late join).
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
                if (this.ignoreOffer) return;
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
        this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = this.pc.ontrack = this.pc.onnegotiationneeded = null;
        this.senders.clear(); this.receivedStreams.clear();
        this.channel?.close(); this.pc.close(); this.onEnd(error);
    }
}

class RtcHost {
    constructor(session, { signalingUrl = 'wss://api.homegames.io/rtc', joinUrl = 'https://homegames.io/play.html',
        onStatus = () => {}, worker = true, iceTransportPolicy = 'all', room = null, visibility = 'private',
        onRoom = () => {}, onHeartbeat = () => {}, onEnd = () => {} } = {}) {
        Object.assign(this, { session, signalingUrl, joinUrl, onStatus, worker, iceTransportPolicy, room, visibility, onRoom, onHeartbeat, onEnd });
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
            this.network = new RtcNetwork({ worker: this.worker });
            this.signal = this.network.signal(signalUrl(this.signalingUrl), { type: 'create', game: this.room,
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
                        this.signal.startHeartbeat(msg.heartbeatIntervalMs, { type: 'heartbeat', playerCount: this.session.players?.length || 1 });
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
            }, error => { this.stop(error); if (error) this.onStatus(error.message); },
            payload => { if (this.link) this.onHeartbeat(payload.playerCount); });
        });
        return this.pending.catch(err => { this.stop(err); throw err; });
    }
    heartbeat() {
        const playerCount = Math.min(17, this.session.players?.length || 1);
        if (this.supportsHeartbeat) this.signal?.heartbeat({ type: 'heartbeat', playerCount });
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
            host: true, network: this.network, iceServers, iceTransportPolicy: this.iceTransportPolicy,
            sendSignal: data => this.signal?.send({ type: 'signal', peerId, ...data }),
            // Give every connected guest the same public invitation URL,
            // including guests who joined through discovery or a LAN dashboard.
            // Older clients ignore text control messages from the host.
            onOpen: channel => channel.send(JSON.stringify({ type: 'invitation', url: this.link })),
            onTrack: stream => { if (seat && this.session.media?.attach(seat.playerId, stream)) peer.receivedStreams.delete(stream.id); },
            onMessage: data => {
                try {
                    if (typeof data !== 'string') throw new Error('Expected player input');
                    if (Date.now() - windowAt > 1000) { windowAt = Date.now(); count = 0; }
                    if (++count > 240) throw new Error('Too much player input');
                    if (!seat) {
                        const ready = JSON.parse(data);
                        if (ready.type !== 'ready') throw new Error('Expected player handshake');
                        seat = this.session.addRemotePlayer({ send: (bytes, options) => peer.channel.send(bytes, options),
                            close: () => peer.close(), playerName: ready.playerName, clientInfo: ready.clientInfo?.clientInfo || {} });
                        if (ready.media === 1) this.session.media?.join(seat.playerId, {
                            recording: ready.recording === 1 || ready.recording === 2,
                            audioRecording: ready.recording === 2,
                            send: message => peer.channel.send(JSON.stringify(message)),
                            addMedia: (id, stream) => peer.addMedia(id, stream),
                            removeMedia: id => peer.removeMedia(id),
                        });
                        this.heartbeat(); this.status();
                    } else {
                        const message = JSON.parse(data);
                        if (message.type === 'media') {
                            this.session.media?.handle(seat.playerId, message);
                            for (const stream of peer.receivedStreams.values()) {
                                if (this.session.media?.attach(seat.playerId, stream)) peer.receivedStreams.delete(stream.id);
                            }
                        } else seat.handleMessage(data);
                    }
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
    getStats() { return this.network?.getStats() || Promise.resolve({ worker: false, channels: [] }); }
    stop(error = new Error('The invitation ended')) {
        if (this.link || this.pending) this.onEnd();
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
        this.network?.close(); this.network = null;
    }
}

// Transport factory for the existing HomegamesClient view/protocol lifecycle.
const createRtcTransport = ({ roomId, invite, signalingUrl, joinUrl = 'https://homegames.io/play.html',
    worker = true, iceTransportPolicy = 'all' }) => callbacks => {
    const network = new RtcNetwork({ worker });
    let peer = null, closed = false, connected = false, signal, shareLink = null;
    const receive = data => {
        if (typeof data !== 'string') { callbacks.onMessage(data); return; }
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'media') { callbacks.onMedia?.(msg); return; }
            if (msg.type !== 'invitation' || typeof msg.url !== 'string' || msg.url.length > 4096) return;
            const url = new URL(msg.url);
            const invitation = readInvitation(url.hash);
            // Only accept a link to the room/ signaling service we joined.
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
                && invitation?.roomId === roomId && invitation.invite
                && signalUrl(invitation.signalingUrl) === signalUrl(signalingUrl)) shareLink = url.href;
        } catch (_) { /* Ignore unknown/malformed optional host metadata. */ }
    };
    const end = error => {
        if (closed) return;
        closed = true; peer?.close(); signal?.close(); network.close();
        if (error && !connected) callbacks.onError(error);
        callbacks.onClose();
    };
    try {
        signal = network.signal(signalUrl(signalingUrl), { type: 'join', roomId, invite }, msg => {
            if (msg.type === 'joined') {
                peer = new Peer({ network, iceServers: msg.iceServers, iceTransportPolicy,
                    onTrack: stream => callbacks.onTrack?.(stream),
                    sendSignal: data => signal.send({ type: 'signal', ...data }),
                    onOpen: () => { connected = true; callbacks.onOpen(); }, onMessage: receive, onEnd: end });
            } else if (msg.type === 'signal') peer?.signal(msg);
        }, end);
    } catch (err) { queueMicrotask(() => end(err)); }
    return {
        send: data => peer?.channel?.send(data), getStats: () => network.getStats(),
        addMedia: (id, stream) => peer?.addMedia(id, stream), removeMedia: id => peer?.removeMedia(id),
        getShareLink: () => {
            if (closed) throw new Error('This session has ended');
            if (!connected) throw new Error('Connect to the host before sharing this game');
            if (shareLink) return shareLink;
            // Hosts running an older client do not send invitation metadata.
            const url = new URL(joinUrl, window.location.href);
            const params = new URLSearchParams({ room: roomId, signal: signalUrl(signalingUrl) });
            if (invite) params.set('invite', invite);
            url.hash = params.toString();
            return url.href;
        },
        close: () => { closed = true; peer?.close(); signal?.close(); network.close(); },
    };
};

const readInvitation = (hash = window.location.hash) => {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    if (!params.has('room')) return null;
    return { roomId: params.get('room'), invite: params.get('invite'), signalingUrl: params.get('signal') };
};

module.exports = { RtcHost, createRtcTransport, readInvitation, Peer, signalUrl };
