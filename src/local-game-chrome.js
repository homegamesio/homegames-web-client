const useFrameStyles = require('./session-frame-styles');
const { createPlayerToolbar } = require('homegames-common/player-toolbar');

const createLocalChrome = (containerId, title, onHome, share = null, options = {}) => {
    const container = document.getElementById(containerId);
    if (!container) throw new Error('Container element not found: #' + containerId);
    container.innerHTML = '';
    const releaseStyles = useFrameStyles();
    const frame = document.createElement('div'); frame.className = 'hg-session-frame';
    const toolbar = createPlayerToolbar(window, { title, author: options.author, home: onHome, status: options.status || 'Playing locally',
        onOpen: options.onOpen || share?.onOpen, onClose: options.onClose || share?.onClose });
    toolbar.bar.classList.add('hg-session-bar');
    if (options.onExports) toolbar.setAction('exports', { label: 'View exports', run: options.onExports });
    const gameArea = document.createElement('div'); gameArea.className = 'hg-session-game';
    gameArea.id = `${containerId}-hg-local-area`;
    frame.append(toolbar.bar, gameArea); container.append(frame);
    let dialog;
    if (share) {
        dialog = require('./share-dialog')({ container: frame, ...share });
        toolbar.setAction('share', { label: 'Share', run: () => dialog.show() });
        if (share.onVisibility) {
            let privateGame = share.private;
            const update = () => toolbar.setAction('privacy', { label: privateGame ? 'Make session public' : 'Make session private', run: async () => {
                await share.onVisibility(privateGame ? 'public' : 'private'); privateGame = !privateGame; update();
            } }); update();
        }
    }
    let disposed = false;
    return { bar: toolbar.bar, toolbar, gameArea, containerId: gameArea.id,
        setStatus: text => toolbar.setStatus(text),
        dispose() { if (disposed) return; disposed = true; dialog?.dispose(); toolbar.dispose(); frame.remove(); releaseStyles(); },
    };
};
createLocalChrome.addExportsButton = (bar, onExports) => {
    const toolbar = bar.homegamesToolbar;
    toolbar?.setAction('exports', { label: 'View exports', run: onExports });
    return () => toolbar?.setAction('exports', null);
};
module.exports = createLocalChrome;
