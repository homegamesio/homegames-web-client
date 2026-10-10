// Serialized into a Blob with its two explicit dependencies. No DOM, globals
// from the bundle, imported scripts, or game/rendering code belongs here.
module.exports = function rtcWorker(RtcChannel, connectSignal) {
    const channels = new Map();
    let signal = null;
    const emit = (type, data = {}, transfer = []) => postMessage({ type, ...data }, transfer);
    const fail = (id, error) => emit('channel-error', { id, message: error.message });
    onmessage = ({ data: message }) => {
        const { type, id, data } = message;
        if (type === 'signal-open') {
            signal = connectSignal(message.url, message.hello,
                data => emit('signal-message', { data }),
                error => emit('signal-end', { message: error?.message }),
                data => emit('heartbeat', { data }));
        } else if (type === 'signal-send') signal?.send(data);
        else if (type === 'heartbeat-start') signal?.startHeartbeat(message.interval, data);
        else if (type === 'heartbeat-update') signal?.heartbeat(data);
        else if (type === 'signal-close') { signal?.close(); signal = null; }
        else if (type === 'bind') {
            const channel = message.channel;
            let opened = false;
            const mailbox = new RtcChannel.Mailbox(data => emit('data', { id, data },
                typeof data === 'string' ? [] : [data.buffer || data]), error => fail(id, error));
            const protocol = new RtcChannel(channel, {
                onMessage: data => mailbox.send(data, true),
                onError: error => fail(id, error),
                onClose: () => { mailbox.close(); channels.delete(id); emit('channel-close', { id }); },
            });
            channels.set(id, { protocol, mailbox });
            const open = () => {
                if (opened || protocol.closed) return;
                opened = true; protocol.flush(); emit('channel-open', { id });
            };
            channel.onopen = open;
            if (channel.readyState === 'open') open();
        } else if (type === 'send') {
            channels.get(id)?.protocol.send(data);
            emit('sent', { id });
        } else if (type === 'received') channels.get(id)?.mailbox.ack();
        else if (type === 'channel-close') {
            const entry = channels.get(id);
            channels.delete(id); entry?.mailbox.close(); entry?.protocol.close();
        } else if (type === 'stats') {
            emit('stats', { id, channels: [...channels].map(([id, { protocol, mailbox }]) => ({
                id, mode: 'worker', ...protocol.stats, queuedBytes: protocol.queuedBytes,
                bufferedBytes: protocol.channel.bufferedAmount, receiveQueueBytes: mailbox.bytes,
                receiveReplacedFrames: mailbox.replacedFrames,
            })) });
        }
    };
};
