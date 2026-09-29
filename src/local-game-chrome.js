// Home-server navigation chrome, outside the game canvas.
const createLocalChrome = (containerId, title, onHome) => {
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
    bar.appendChild(homeButton);

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
    return { bar, gameArea, containerId: gameArea.id, dispose() { bar.remove(); gameArea.remove(); } };
};

module.exports = createLocalChrome;
