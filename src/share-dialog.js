const qrcode = require('qrcode-generator');

// The encoder runs locally: invitation capabilities never go to a QR service.
module.exports = function createShareDialog({ container, getLink, onOpen, onClose,
    title = 'Share this game', readyText = 'Anyone with this link can join', closeLabel = 'Done',
    hintText = 'Scan to join. Keep this game tab open.' }) {
    const dialog = document.createElement('dialog');
    const releaseStyles = require('./session-frame-styles')();
    dialog.className = 'hg-share-dialog';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2'); heading.textContent = title;
    const hint = document.createElement('p'); hint.textContent = hintText;
    hint.className = 'hg-share-hint';
    const qr = document.createElement('div');
    qr.className = 'hg-share-qr';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.className = 'hg-share-status';
    const link = document.createElement('input'); link.readOnly = true;
    link.setAttribute('aria-label', 'Invitation link');
    link.className = 'hg-share-link';
    const actions = document.createElement('div');
    actions.className = 'hg-share-actions';
    const button = (text, action) => {
        const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
        el.onclick = action; actions.appendChild(el); return el;
    };
    const copy = button('Copy link', async () => {
        try { await navigator.clipboard.writeText(link.value); status.textContent = 'Link copied'; }
        catch (_) { link.focus(); link.select(); status.textContent = 'Copy the selected invitation link'; }
    });
    copy.className = 'hg-share-copy';
    const close = button(closeLabel, () => dialog.close());
    [heading, hint, qr, status, link, actions].forEach(el => dialog.appendChild(el));
    container.appendChild(dialog);
    let generation = 0, disposed = false;
    dialog.onclose = () => { generation++; onClose?.(); };
    dialog.addEventListener('click', event => { if (event.target === dialog) {
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    } });
    return {
        setStatus(text) { if (!disposed) status.textContent = text; },
        async show() {
            if (disposed || dialog.open) return;
            const current = ++generation;
            qr.innerHTML = ''; qr.hidden = true; link.value = ''; link.hidden = true; copy.disabled = true;
            status.textContent = 'Creating invitation…'; dialog.showModal(); onOpen?.(); close.focus();
            try {
                const url = await getLink();
                if (current !== generation) return;
                const code = qrcode(0, 'M'); code.addData(url); code.make();
                // SVG comes only from the QR encoder's numeric module grid.
                qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
                qr.firstChild.style.cssText = 'display:block;width:100%;height:100%;background:white';
                qr.hidden = false;
                link.value = url; link.hidden = false; copy.disabled = false;
                status.textContent = readyText;
            } catch (err) { if (current === generation) status.textContent = err.message; }
        },
        dispose() {
            if (disposed) return;
            disposed = true; generation++;
            if (dialog.open) dialog.close();
            dialog.remove(); releaseStyles();
        },
    };
};
