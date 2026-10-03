// Home-server navigation chrome, outside the game canvas.
const createLocalChrome = (containerId, title, onHome, share = null) => {
    const container = document.getElementById(containerId);
    if (!container) throw new Error('Container element not found: #' + containerId);

    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.background = '#000';

    const bar = document.createElement('div');
    bar.style.cssText = 'height:40px;display:flex;align-items:center;gap:12px;'
        + 'padding:0 10px;background:#4D4D4D;box-sizing:border-box;'
        + 'font-family:sans-serif;';

    const homeButton = document.createElement('div');
    homeButton.style.cssText = 'background:#FFF78E;color:#1a1a1a;padding:5px 14px;'
        + 'border-radius:6px;font-size:14px;cursor:pointer;user-select:none;';
    homeButton.textContent = '⌂ Home';
    homeButton.onclick = onHome;
    if (onHome) bar.appendChild(homeButton);

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'color:#fff;font-size:14px;opacity:0.85;';
    titleEl.textContent = title || '';
    bar.appendChild(titleEl);

    const gameArea = document.createElement('div');
    gameArea.id = `${containerId}-hg-local-area`;
    gameArea.style.cssText = 'position:relative;width:100%;height:calc(100% - 40px);'
        + 'overflow:hidden;background:#000;';

    container.appendChild(bar);
    container.appendChild(gameArea);
    let footer, dialog, status;
    if (share) {
        gameArea.style.height = 'calc(100% - 92px)';
        footer = document.createElement('div');
        footer.style.cssText = 'height:52px;padding:0 8px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;background:#242424;font:14px system-ui,sans-serif;color:#ccc';
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Share';
        button.style.cssText = 'border:0;border-radius:6px;padding:8px 24px;background:#fff78e;color:#222;font:600 15px system-ui,sans-serif;cursor:pointer';
        status = document.createElement('span'); status.textContent = 'Playing locally';
        status.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px';
        status.setAttribute('role', 'status');
        dialog = require('./share-dialog')({ container, ...share });
        button.onclick = () => dialog.show();
        footer.appendChild(button); footer.appendChild(status); container.appendChild(footer);
        if (share.onVisibility) {
            const label = document.createElement('label');
            label.style.cssText = 'flex-shrink:0;white-space:nowrap';
            const privateCheck = document.createElement('input'); privateCheck.type = 'checkbox';
            privateCheck.checked = share.private;
            privateCheck.setAttribute('aria-label', 'Private game');
            label.appendChild(privateCheck); label.appendChild(document.createTextNode(' Private'));
            privateCheck.onchange = async () => {
                const desired = privateCheck.checked; privateCheck.disabled = true;
                try { await share.onVisibility(desired ? 'private' : 'public'); }
                catch (err) { privateCheck.checked = !desired; status.textContent = err.message; }
                finally { privateCheck.disabled = false; }
            };
            footer.appendChild(label);
        }
    }
    return { bar, gameArea, containerId: gameArea.id,
        setStatus(text) { if (status) status.textContent = text; },
        dispose() { dialog?.dispose(); footer?.remove(); bar.remove(); gameArea.remove(); } };
};

module.exports = createLocalChrome;
