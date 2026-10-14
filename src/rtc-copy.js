'use strict';
const RtcNetwork = require('./rtc-network');
const { Peer, signalUrl } = require('./rtc-session');
const protocol = require('./rtc-copy-protocol');
const portable = require('./portable-project');

class CopyHost {
    constructor(project, { signalingUrl = 'wss://api.homegames.io/rtc', receiveUrl = 'https://homegames.io/game-app.html',
        worker = true, iceTransportPolicy = 'all', onStatus = () => {} } = {}) {
        Object.assign(this, { project, signalingUrl, receiveUrl, worker, iceTransportPolicy, onStatus });
        this.peers = new Map(); this.closed = false;
    }
    share() {
        if (this.closed) return Promise.reject(new Error('Copy sharing has stopped. Open Share a copy again.'));
        return this.pending ||= this.start();
    }
    async start() {
        this.bytes = await portable.exportArchive(this.project);
        const sha256 = await protocol.digest(this.bytes);
        if (this.closed) throw new Error('Copy sharing stopped');
        this.metadata = { type: 'copy-offer', protocol: 1, name: String(this.project.metadata.name || 'Homegame').slice(0, 200),
            gameId: this.project.manifest.gameId, revision: this.project.revision, bytes: this.bytes.length, sha256 };
        this.network = new RtcNetwork({ worker: this.worker });
        return new Promise((resolve, reject) => {
            this.reject = reject;
            this.signal = this.network.signal(signalUrl(this.signalingUrl), { type: 'create', visibility: 'private', maxPlayers: 5 }, msg => {
                if (msg.type === 'created') {
                    const url = new URL(this.receiveUrl, window.location.href);
                    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid game-copy destination');
                    url.search = new URLSearchParams({ game: this.metadata.gameId, revision: this.metadata.revision });
                    url.hash = new URLSearchParams({ copy: '1', room: msg.roomId, invite: msg.invite, signal: signalUrl(this.signalingUrl) });
                    this.link = url.href; this.reject = null;
                    if (msg.heartbeatIntervalMs) this.signal.startHeartbeat(msg.heartbeatIntervalMs, { type: 'heartbeat', playerCount: 1 });
                    this.onStatus('Ready to send a copy'); resolve(this.link);
                } else if (msg.type === 'peer-joined') this.addPeer(msg);
                else if (msg.type === 'peer-left') this.peers.get(msg.peerId)?.close();
                else if (msg.type === 'signal') this.peers.get(msg.peerId)?.signal(msg);
            }, error => { this.close(error); if (error) this.onStatus(error.message); });
        });
    }
    addPeer({ peerId, iceServers }) {
        let sender, timer;
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => peer.close(new Error('Copy transfer timed out. Open the invitation to try again.')), 120000); };
        const peer = new Peer({ host: true, network: this.network, iceServers, iceTransportPolicy: this.iceTransportPolicy,
            sendSignal: data => this.signal?.send({ type: 'signal', peerId, ...data }),
            onOpen: channel => {
                sender = new protocol.Sender(this.bytes, this.metadata, data => channel.send(data), (done, total) => this.onStatus(`Sending copy · ${Math.round(done / total * 100)}%`));
                arm(); sender.open();
            },
            onMessage: data => { try { arm(); sender.receive(data); } catch (error) { peer.close(error); } },
            onEnd: error => { clearTimeout(timer); this.peers.delete(peerId); this.signal?.send({ type: 'remove', peerId });
                if (!this.closed) this.onStatus(error ? error.message : 'Ready to send another copy'); },
        });
        this.peers.set(peerId, peer); peer.offer();
    }
    close(error) {
        if (this.closed) return;
        this.closed = true; this.reject?.(error || new Error('Copy sharing stopped')); this.reject = null;
        this.signal?.close(); for (const peer of this.peers.values()) peer.close(); this.peers.clear(); this.network?.close(); this.bytes = null;
    }
}

function readCopyInvitation(value) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Paste a Share a copy invitation');
    const url = new URL(value, window.location.href), params = new URLSearchParams(url.hash.slice(1));
    if (!['http:', 'https:'].includes(url.protocol) || params.get('copy') !== '1'
        || !/^[A-Za-z0-9_-]{24}$/.test(params.get('room')) || !/^[A-Za-z0-9_-]{24}$/.test(params.get('invite'))) throw new Error('Paste a Share a copy invitation');
    if (!/^wss?:\/\//.test(params.get('signal') || '')) throw new Error('Invalid invitation service');
    const signalingUrl = signalUrl(params.get('signal'));
    const signal = new URL(signalingUrl);
    if (signal.username || signal.password || signal.hash || signal.search) throw new Error('Invalid invitation service');
    return { roomId: params.get('room'), invite: params.get('invite'), signalingUrl };
}

function receiveCopy(invitation, { onOffer, onProgress, onComplete, onError = () => {}, worker = true, iceTransportPolicy = 'all' }) {
    const network = new RtcNetwork({ worker });
    let peer, signal, receiver, closed = false, complete = false, disconnected = false, timer;
    const disconnect = () => { if (disconnected) return; disconnected = true; clearTimeout(timer); peer?.close(); signal?.close(); network.close(); };
    const close = () => { if (closed) return; closed = true; receiver?.close(); disconnect(); };
    const fail = error => { if (closed) return; close(); if (!complete) onError(error || new Error('The sender disconnected before the copy was saved. Open the invitation to try again.')); };
    // Once the complete archive has arrived, verification and local persistence
    // no longer need the sender. A transport closure must not discard that copy.
    const transportEnded = error => { if (disconnected || closed) return; if (receiver?.state === 'validating' || complete) disconnect(); else fail(error); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('Copy transfer timed out. Open the invitation to try again.')), 120000); };
    // A transferred RTC channel can deliver its first message before Window
    // receives the open notification. Prepare the protocol before binding it.
    receiver = new protocol.Receiver(data => { if (!disconnected) peer.channel.send(data); }, { onOffer, onProgress, importArchive: portable.importArchive,
        onComplete: async value => { clearTimeout(timer); await onComplete(value); complete = true; setTimeout(close, 100); } });
    signal = network.signal(signalUrl(invitation.signalingUrl), { type: 'join', roomId: invitation.roomId, invite: invitation.invite }, msg => {
        if (msg.type === 'joined') peer = new Peer({ network, iceServers: msg.iceServers, iceTransportPolicy,
            sendSignal: data => signal.send({ type: 'signal', ...data }),
            onOpen: arm,
            onMessage: data => { arm(); receiver.receive(data).catch(fail); }, onEnd: transportEnded,
        });
        else if (msg.type === 'signal') peer?.signal(msg);
    }, transportEnded);
    return { accept: () => { if (closed || !receiver) throw new Error('Reconnect to the sender to receive this game'); arm(); receiver.accept(); }, close };
}

function showCopyShare(project, settings = {}) {
    let dialog;
    let closed = false;
    const host = new CopyHost(project, { ...settings, onStatus: text => dialog?.setStatus(text) });
    const close = () => { if (closed) return; closed = true; host.close(); dialog.dispose(); settings.onClose?.(); };
    dialog = require('./share-dialog')({ container: document.body, getLink: () => host.share(), title: 'Share a copy',
        hintText: 'Your source, sounds and images are included. Keep this window open until the other person has saved their copy.',
        readyText: 'Anyone with this link can keep an independent, editable copy.', closeLabel: 'Stop sharing',
        onOpen: settings.onOpen, onClose: close });
    dialog.show(); return { close };
}
module.exports = { CopyHost, receiveCopy, readCopyInvitation, showCopyShare };
