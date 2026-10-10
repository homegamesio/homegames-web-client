// This function also runs inside the communication worker. URLs are normalized
// before crossing that boundary; everything it owns is released on close.
function connectSignal(url, hello, onMessage, onEnd, onHeartbeat = () => {}) {
    const ws = new WebSocket(url);
    let ended = false, heartbeatTimer = null, heartbeat = null;
    const end = error => {
        if (ended) return;
        ended = true; clearTimeout(timer); clearInterval(heartbeatTimer);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close(); onEnd(error);
    };
    const timer = setTimeout(() => end(new Error('Signaling connection timed out')), 15000);
    const send = msg => { if (!ended && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
    ws.onopen = () => send(hello);
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
        send,
        startHeartbeat(interval, payload) {
            clearInterval(heartbeatTimer); heartbeat = payload;
            if (!ended && Number.isFinite(interval) && interval > 0) heartbeatTimer = setInterval(() => {
                send(heartbeat); onHeartbeat(heartbeat);
            }, interval);
        },
        heartbeat(payload) { heartbeat = payload; send(payload); },
        close: () => end(null),
    };
}
module.exports = connectSignal;
