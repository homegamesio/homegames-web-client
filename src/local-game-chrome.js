const useFrameStyles = require('./session-frame-styles');

// Navigation and session controls live outside the canvas, for both a local
// host and an invited player. Home can be a URL or an in-place dashboard action.
const createLocalChrome = (containerId, title, onHome, share = null, options = {}) => {
    const container = document.getElementById(containerId);
    if (!container) throw new Error('Container element not found: #' + containerId);
    container.innerHTML = '';
    const releaseStyles = useFrameStyles();
    const element = (tag, className, text) => {
        const el = document.createElement(tag);
        el.className = className;
        if (text) el.textContent = text;
        return el;
    };
    const frame = element('div', 'hg-session-frame');
    const bar = element('header', 'hg-session-bar' + (onHome ? ' hg-session-has-home' : ''));
    bar.setAttribute('aria-label', 'Game session');
    if (onHome) {
        const home = element(typeof onHome === 'string' ? 'a' : 'button', 'hg-session-home', '⌂ Home');
        if (typeof onHome === 'string') home.href = onHome;
        else { home.type = 'button'; home.onclick = onHome; }
        bar.appendChild(home);
    }
    const titleEl = element('h1', 'hg-session-title', title || 'Homegames');
    titleEl.title = title || 'Homegames';
    bar.appendChild(titleEl);
    const status = element('p', 'hg-session-status', options.status || 'Playing locally');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-atomic', 'true');
    bar.appendChild(status);

    const gameArea = element('div', 'hg-session-game');
    gameArea.id = `${containerId}-hg-local-area`;
    frame.appendChild(bar);
    frame.appendChild(gameArea);
    container.appendChild(frame);
    let dialog;
    if (share) {
        const button = element('button', 'hg-session-share', 'Share');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        dialog = require('./share-dialog')({ container: frame, ...share });
        button.onclick = () => dialog.show();
        if (share.onVisibility) {
            const label = element('label', 'hg-session-private');
            label.title = 'Hide this session from public games. Anyone with your invitation can still join.';
            const privateCheck = document.createElement('input');
            privateCheck.type = 'checkbox'; privateCheck.checked = share.private;
            privateCheck.setAttribute('aria-label', 'Private game');
            label.appendChild(privateCheck);
            label.appendChild(element('span', 'hg-session-switch'));
            label.appendChild(element('span', '', 'Private'));
            privateCheck.onchange = async () => {
                const desired = privateCheck.checked;
                privateCheck.disabled = true;
                try { await share.onVisibility(desired ? 'private' : 'public'); }
                catch (err) { privateCheck.checked = !desired; status.textContent = err.message; status.title = err.message; }
                finally { privateCheck.disabled = false; }
            };
            bar.appendChild(label);
        }
        bar.appendChild(button);
    }
    let disposed = false;
    return { bar, gameArea, containerId: gameArea.id,
        setStatus(text) { status.textContent = text; status.title = text; },
        dispose() {
            if (disposed) return;
            disposed = true;
            dialog?.dispose(); frame.remove(); releaseStyles();
        },
    };
};

module.exports = createLocalChrome;
