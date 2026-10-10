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
            .hg-session-bar { flex:none; height:76px; display:grid; grid-template-areas:"title privacy share" "status privacy share"; grid-template-columns:minmax(0,1fr) auto auto; grid-template-rows:24px 20px; align-content:center; align-items:center; column-gap:20px; padding:0 max(20px,env(safe-area-inset-right)) 0 max(20px,env(safe-area-inset-left)); background:#202321; border-bottom:1px solid #363b36; }
            .hg-session-has-home { grid-template-areas:"home title privacy share" "home status privacy share"; grid-template-columns:auto minmax(0,1fr) auto auto; }
            .hg-session-title { grid-area:title; min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 16px/24px system-ui,sans-serif; letter-spacing:-.2px; }
            .hg-session-status { grid-area:status; min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#b7bfb5; font-size:12px; line-height:20px; }
            .hg-session-home, .hg-session-share, .hg-share-dialog button { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:44px; padding:0 18px; border:1px solid #4a5049; border-radius:10px; background:transparent; color:#f6f6ee; font:600 14px/1.2 system-ui,sans-serif; text-decoration:none; white-space:nowrap; cursor:pointer; }
            .hg-session-home { grid-area:home; padding:0 14px; }
            .hg-session-home:hover, .hg-share-dialog button:hover { background:#343a32; }
            .hg-session-share, .hg-share-dialog .hg-share-copy { background:#fff78e; border-color:#fff78e; color:#22261e; }
            .hg-session-share { grid-area:share; min-width:92px; }
            .hg-session-share:hover, .hg-share-dialog .hg-share-copy:hover { background:#fffbb5; border-color:#fffbb5; }
            .hg-session-frame :focus-visible, .hg-share-dialog :focus-visible { outline:2px solid #fff78e; outline-offset:4px; }
            .hg-session-private { grid-area:privacy; display:flex; align-items:center; gap:8px; min-height:44px; position:relative; cursor:pointer; color:#cbd1c8; font-size:12px; white-space:nowrap; }
            .hg-session-private input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
            .hg-session-switch { width:28px; height:17px; border-radius:20px; border:1px solid #798275; padding:3px; background:#343b31; }
            .hg-session-switch::after { content:""; display:block; width:9px; height:9px; border-radius:50%; background:#cbd1c8; }
            .hg-session-private input:checked + .hg-session-switch { background:#fff78e; border-color:#fff78e; }
            .hg-session-private input:checked + .hg-session-switch::after { transform:translateX(11px); background:#22261e; }
            .hg-session-private input:focus-visible { outline:none; }
            .hg-session-private input:focus-visible + .hg-session-switch { outline:2px solid #fff78e; outline-offset:4px; }
            .hg-session-private input:disabled ~ span { opacity:.45; }
            .hg-session-game { flex:1; min-height:0; width:100%; position:relative; overflow:hidden; display:flex; align-items:center; background:#000; }
            @container (max-width:600px) {
                .hg-session-bar { height:100px; padding-left:max(12px,env(safe-area-inset-left)); padding-right:max(12px,env(safe-area-inset-right)); grid-template-areas:"title title share" "status status privacy"; grid-template-columns:auto minmax(0,1fr) auto; grid-template-rows:44px 28px; gap:4px 12px; }
                .hg-session-has-home { grid-template-areas:"home title share" "status status privacy"; }
                .hg-session-title { font-size:14px; }
                .hg-session-home { padding:0 10px; font-size:12px; }
                .hg-session-share { min-width:76px; padding:0 14px; }
                .hg-session-private { min-height:28px; justify-self:end; }
                .hg-session-status { font-size:11px; }
            }
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
