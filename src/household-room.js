// Publication on the home server is separate from public catalog discovery.
// The owner capability is never included in its directory responses.
module.exports = function householdRoom(game, reportError = () => {}) {
    let registration = null, pending = null, stopped = false;
    const post = async data => {
        const response = await fetch('/household-rooms', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
        if (!response.ok) throw new Error('Unable to list this game on your home server');
        return response.json();
    };
    return {
        onRoom(link) {
            stopped = false;
            const invite = new URLSearchParams(new URL(link).hash.slice(1));
            const request = pending = post({ gameKey: game.gameKey, versionId: game.versionId,
                roomId: invite.get('room'), invite: invite.get('invite') });
            request.then(value => {
                if (stopped || pending !== request) { post({ ...value, remove: true }).catch(() => {}); return; }
                registration = value;
            }).catch(reportError);
        },
        onHeartbeat(playerCount) {
            if (registration) post({ ...registration, playerCount }).catch(err => {
                registration = null; reportError(err);
            });
        },
        onEnd() {
            stopped = true; pending = null;
            if (registration) post({ ...registration, remove: true }).catch(() => {});
            registration = null;
        },
    };
};
