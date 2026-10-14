const RtcNetwork = require('./rtc-network');

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_HANDSHAKE = 128 * 1024;
function readHandshake(text, kind) {
    if (typeof text !== 'string' || text.length > MAX_HANDSHAKE) throw new Error('Handshake is missing or too large');
    let value; try { value = JSON.parse(text.trim()); } catch (_) { throw new Error('Paste the complete handshake text'); }
    if (value?.format !== 'homegames-rtc' || value.version !== 1 || value.kind !== kind
        || !/^[0-9a-f-]{36}$/i.test(value.id || '') || value.description?.type !== kind
        || typeof value.description.sdp !== 'string' || !value.description.sdp.startsWith('v=0')
        || (value.description.sdp.match(/^a=candidate:/gm) || []).length > 128
        || /^m=(audio|video) /m.test(value.description.sdp)) throw new Error(`This is not a supported Homegames ${kind}`);
    return value;
}
function handshake(peer, kind) {
    const text = JSON.stringify({format:'homegames-rtc',version:1,kind,id:peer.id,description:peer.pc.localDescription.toJSON()});
    if(text.length>MAX_HANDSHAKE)throw new Error('Handshake is too large');return text;
}
function gather(peer) {
    if (peer.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve,reject) => {
        const done = error => {clearTimeout(timer);peer.pc.removeEventListener('icegatheringstatechange',changed);peer.cancelGather=null;error?reject(error):resolve();};
        const changed = () => {if(peer.pc.iceGatheringState==='complete')done();};
        const timer=setTimeout(()=>done(new Error('Network discovery timed out. Retry, or disable public STUN for a local-network connection.')),20000);
        peer.cancelGather=()=>done(new Error('Manual pairing cancelled'));peer.pc.addEventListener('icegatheringstatechange',changed);changed();
    });
}
class ManualPeer {
    constructor({id=crypto.randomUUID(),iceServers=DEFAULT_ICE,onOpen=()=>{},onMessage=()=>{},onEnd=()=>{}}={}) {
        Object.assign(this,{id,onEnd});this.closed=false;this.network=new RtcNetwork({worker:false});
        this.pc=new RTCPeerConnection({iceServers});
        this.bind=channel=>{
            if(this.channel||this.closed){channel.close();return;}
            this.channel=this.network.bind(channel,{onOpen:()=>{clearTimeout(this.expiry);onOpen();},onMessage,
                onClose:()=>this.close(),onError:error=>this.close(error)});
        };
        this.pc.ondatachannel=event=>this.bind(event.channel);
        this.pc.onconnectionstatechange=()=>{
            if(this.pc.connectionState==='failed')this.close(new Error('Could not connect directly. This network may require a TURN relay.'));
            clearTimeout(this.disconnected);
            if(this.pc.connectionState==='disconnected')this.disconnected=setTimeout(()=>this.close(new Error('The other player disconnected')),10000);
        };
        // Human exchange takes much longer than a signaling round trip.
        this.expiry=setTimeout(()=>this.close(new Error('Handshake expired. Create a fresh offer.')),10*60*1000);
    }
    close(error) {
        if(this.closed)return;this.closed=true;clearTimeout(this.expiry);clearTimeout(this.disconnected);this.cancelGather?.();
        this.pc.ondatachannel=this.pc.onconnectionstatechange=null;this.network.close();this.pc.close();this.onEnd(error);
    }
}
class ManualHost {
    constructor(session,{iceServers=DEFAULT_ICE,onStatus=()=>{}}={}) {Object.assign(this,{session,iceServers,onStatus});this.peers=new Set();this.pending=null;}
    async createOffer() {
        if(!this.session.game)throw new Error('Start the game before creating an offer');
        this.cancelOffer();
        let seat=null,windowAt=Date.now(),count=0;
        const peer=new ManualPeer({iceServers:this.iceServers,
            onMessage:data=>{
                try {
                    if(typeof data!=='string'||data.length>65536)throw new Error('Invalid player input');
                    if(Date.now()-windowAt>1000){windowAt=Date.now();count=0;}if(++count>240)throw new Error('Too much player input');
                    if(!seat){const ready=JSON.parse(data);if(ready.type!=='ready')throw new Error('Expected player handshake');
                        seat=this.session.addRemotePlayer({send:(bytes,settings)=>peer.channel.send(bytes,settings),close:()=>peer.close(),clientInfo:ready.clientInfo?.clientInfo||{}});
                        this.onStatus('Manual player connected');
                    }else seat.handleMessage(data);
                }catch(error){peer.close(error);}
            },
            onEnd:error=>{this.peers.delete(peer);if(this.pending===peer)this.pending=null;seat?.leave();this.onStatus(error?.message||'Manual player disconnected');}
        });
        this.peers.add(peer);this.pending=peer;peer.bind(peer.pc.createDataChannel('homegames',{ordered:true}));
        try{await peer.pc.setLocalDescription(await peer.pc.createOffer());await gather(peer);if(peer.closed)throw new Error('Offer cancelled');return handshake(peer,'offer');}
        catch(error){peer.close();throw error;}
    }
    async acceptAnswer(text) {
        const answer=readHandshake(text,'answer'),peer=this.pending;
        if(!peer||peer.closed)throw new Error('Create an offer first');
        if(answer.id!==peer.id)throw new Error('This answer belongs to a different offer');
        if(peer.pc.signalingState!=='have-local-offer')throw new Error('This offer has already been answered');
        await peer.pc.setRemoteDescription(answer.description);this.pending=null;
    }
    cancelOffer(){this.pending?.close();this.pending=null;}
    stop(){for(const peer of [...this.peers])peer.close();this.pending=null;}
}
function createManualGuest(text,{iceServers=DEFAULT_ICE,onStatus=()=>{}}={}) {
    const offer=readHandshake(text,'offer');let callbacks=null,connected=false,closed=false;
    const peer=new ManualPeer({id:offer.id,iceServers,
        onOpen:()=>{connected=true;callbacks?.onOpen();onStatus('Connected to host');},
        onMessage:data=>{if(typeof data!=='string')callbacks?.onMessage(data);},
        onEnd:error=>{closed=true;if(error)callbacks?.onError(error);callbacks?.onClose();onStatus(error?.message||'Host disconnected');}
    });
    let answerPromise;
    return {
        transport: handlers=>{
            callbacks=handlers;if(connected)queueMicrotask(()=>callbacks.onOpen());
            return {send:data=>peer.channel?.send(data),close:()=>peer.close(),getStats:()=>peer.network.getStats()};
        },
        answer:()=>answerPromise||(answerPromise=(async()=>{
            try{if(closed)throw new Error('Connection closed');await peer.pc.setRemoteDescription(offer.description);await peer.pc.setLocalDescription(await peer.pc.createAnswer());await gather(peer);return handshake(peer,'answer');}
            catch(error){peer.close();throw error;}
        })()),
        close:()=>peer.close(),
    };
}
module.exports={ManualHost,createManualGuest,readHandshake,DEFAULT_ICE};
