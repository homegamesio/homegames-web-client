const qrcode = require('qrcode-generator');

// The encoder runs locally: invitation capabilities never go to a QR service.
module.exports = function createShareDialog({ container, getLink, onOpen, onClose }) {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Share this game');
    dialog.style.cssText = 'margin:auto;padding:24px;border:1px solid #555;border-radius:16px;'
        + 'background:#242424;color:#fff;font:16px system-ui,sans-serif;width:min(420px,90vw);'
        + 'max-height:90vh;overflow:auto;box-sizing:border-box;text-align:center;box-shadow:0 16px 70px #000b;';
    const heading = document.createElement('h2'); heading.textContent = 'Share this game';
    heading.style.cssText = 'font-size:24px;margin:0 0 8px';
    const hint = document.createElement('p'); hint.textContent = 'Scan to join. Keep this game tab open.';
    hint.style.cssText = 'color:#ccc;font-size:14px;margin:0 0 20px';
    const qr = document.createElement('div');
    qr.style.cssText = 'width:100%;max-width:288px;aspect-ratio:1;margin:0 auto 16px;';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.style.cssText = 'font-size:14px;overflow-wrap:anywhere';
    const link = document.createElement('input'); link.readOnly = true;
    link.setAttribute('aria-label', 'Invitation link');
    link.style.cssText = 'width:100%;padding:10px;box-sizing:border-box;background:#111;color:#ddd;border:1px solid #666;border-radius:6px';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:16px';
    const button = (text, action) => {
        const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
        el.style.cssText = 'padding:10px 18px;border:0;border-radius:6px;background:#fff78e;color:#222;font:inherit;cursor:pointer';
        el.onclick = action; actions.appendChild(el); return el;
    };
    const copy = button('Copy link', async () => {
        try { await navigator.clipboard.writeText(link.value); status.textContent = 'Link copied'; }
        catch (_) { link.focus(); link.select(); status.textContent = 'Copy the selected invitation link'; }
    });
    const close = button('Done', () => dialog.close());
    [heading, hint, qr, status, link, actions].forEach(el => dialog.appendChild(el));
    container.appendChild(dialog);
    let generation = 0;
    dialog.onclose = () => { generation++; onClose?.(); };
    dialog.addEventListener('click', event => { if (event.target === dialog) {
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    } });
    return {
        async show() {
            if (dialog.open) return;
            const current = ++generation;
            qr.innerHTML = ''; link.value = ''; link.hidden = true; copy.disabled = true;
            status.textContent = 'Creating invitation…'; dialog.showModal(); onOpen?.(); close.focus();
            try {
                const url = await getLink();
                if (current !== generation) return;
                const code = qrcode(0, 'M'); code.addData(url); code.make();
                // SVG comes only from the QR encoder's numeric module grid.
                qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
                qr.firstChild.style.cssText = 'display:block;width:100%;height:100%;background:white';
                link.value = url; link.hidden = false; copy.disabled = false;
                status.textContent = 'Anyone with this link can join';
            } catch (err) { if (current === generation) status.textContent = err.message; }
        },
        dispose() { generation++; if (dialog.open) dialog.close(); dialog.remove(); },
    };
};
