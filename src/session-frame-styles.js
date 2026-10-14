// Shared by the game frame and the standalone Studio invitation dialog.
// Reference counting also handles multiple previews in the same document.
const documents = new WeakMap();
module.exports = () => {
    let entry = documents.get(document);
    if (!entry) {
        const style = document.createElement('style');
        style.textContent = `
            .hg-session-frame, .hg-share-dialog { font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,sans-serif; color:#f6f6ee; }
            .hg-session-frame *, .hg-share-dialog * { box-sizing:border-box; }
            .hg-session-frame { width:100%; height:100%; display:flex; flex-direction:column; background:#101211; container-type:inline-size; }
            .hg-session-game { flex:1; min-height:0; width:100%; position:relative; overflow:hidden; display:flex; align-items:center; background:#000; }
            .hg-share-dialog button { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:44px; padding:0 18px; border:1px solid #4a5049; border-radius:10px; background:transparent; color:#f6f6ee; font:600 14px/1.2 system-ui,sans-serif; cursor:pointer; }
            .hg-share-dialog .hg-share-copy { background:#fff78e; color:#22261e; }
            .hg-share-dialog :focus-visible { outline:2px solid #fff78e; outline-offset:4px; }
            .hg-share-dialog { margin:auto; width:min(400px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); padding:24px; border:1px solid #4a5049; border-radius:20px; background:#202321; box-sizing:border-box; overflow:auto; text-align:center; box-shadow:0 24px 80px #0009; }
            .hg-share-dialog::backdrop { background:#080c0ac9; }
            .hg-share-dialog h2 { margin:0 0 8px; font-size:22px; letter-spacing:-.5px; }
            .hg-share-hint { margin:0 0 20px; color:#b7bfb5; font-size:13px; }
            .hg-share-qr { width:100%; max-width:256px; aspect-ratio:1; padding:8px; margin:0 auto 16px; border-radius:12px; overflow:hidden; background:#fff; }
            .hg-share-qr[hidden] { display:none; }
            .hg-share-status { margin:16px 0; color:#cbd1c8; font-size:12px; overflow-wrap:anywhere; }
            .hg-share-link { width:100%; padding:12px; border:1px solid #4a5049; border-radius:8px; background:#111510; color:#cbd1c8; font:12px system-ui,sans-serif; }
            .hg-share-actions { display:flex; gap:10px; margin-top:16px; }
            .hg-share-actions button { flex:1; }
            .hg-share-dialog button:disabled { opacity:.4; cursor:wait; }
        `;
        (document.head || document.body).appendChild(style);
        entry = { style, count: 0 }; documents.set(document, entry);
    }
    entry.count++;
    const owner = document;
    return () => { if (--entry.count === 0) { entry.style.remove(); documents.delete(owner); } };
};
