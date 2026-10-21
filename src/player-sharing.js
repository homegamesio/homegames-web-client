'use strict';
const qrcode = require('qrcode-generator');

// One provider belongs to one running client. A copy invitation remains useful
// after the menu closes, so its transfer host lives until the client stops.
module.exports = function createPlayerSharing({ getInvitation, getProject, onStatus = () => {}, ...settings }) {
    let closed = false, generation = 0, copyHost, copyPending;
    const pending = new Set();
    const stopped = () => new Error('Sharing has stopped. Reopen the game to share it.');
    const closeCopy = () => {
        generation++;
        copyHost?.close(); copyHost = null; copyPending = null;
    };
    function copyLink() {
        if (copyHost?.closed) closeCopy();
        if (copyPending) return copyPending;
        const current = generation;
        const started = Promise.resolve().then(async () => {
            if (typeof getProject !== 'function') throw new Error('Sharing a copy is not available in this player.');
            const project = await getProject();
            if (closed || generation !== current) throw stopped();
            const { CopyHost } = require('./rtc-copy');
            const host = new CopyHost(project, {
                ...settings,
                onStatus: text => {
                    if (!closed && generation === current) {
                        try { onStatus(text, 'copy'); } catch (_) {}
                    }
                },
            });
            copyHost = host;
            const link = await host.share();
            if (closed || generation !== current) { host.close(); throw stopped(); }
            return link;
        });
        copyPending = started.catch(error => {
            if (generation === current) closeCopy();
            throw error;
        });
        return copyPending;
    }
    return {
        getLink(mode) {
            if (closed) return Promise.reject(stopped());
            if (!['session', 'copy'].includes(mode)) return Promise.reject(new Error('Unknown sharing option'));
            return new Promise((resolve, reject) => {
                const entry = { reject, timer: null }; pending.add(entry);
                const finish = (error, value) => {
                    if (!pending.delete(entry)) return;
                    clearTimeout(entry.timer); error ? reject(error) : resolve(value);
                };
                entry.timer = setTimeout(() => {
                    if (mode === 'copy') closeCopy();
                    finish(new Error('Creating an invitation timed out. Check your connection and try again.'));
                }, 30000);
                Promise.resolve().then(() => {
                    if (mode === 'copy') return copyLink();
                    if (typeof getInvitation !== 'function') throw new Error('This session is not available to join.');
                    return getInvitation();
                }).then(url => {
                    if (closed) throw stopped();
                    if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//.test(url)) throw new Error('Invalid invitation link');
                    const code = qrcode(0, 'M'); code.addData(url); code.make();
                    const size = code.getModuleCount();
                    const qr = Array.from({ length: size }, (_, row) =>
                        Array.from({ length: size }, (_, col) => code.isDark(row, col) ? '1' : '0').join(''));
                    finish(null, { url, qr });
                }).catch(error => finish(error));
            });
        },
        dispose() {
            if (closed) return;
            closed = true; closeCopy();
            for (const entry of pending) { clearTimeout(entry.timer); entry.reject(stopped()); }
            pending.clear();
        },
    };
};
