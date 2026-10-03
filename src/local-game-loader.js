// Resolve a manifest and its assets once for website and home-server play.
// Callers supply the endpoint and identity; the runtime does not infer API
// origins, catalog IDs, or save identity from an exported class name.
const loadLocalGame = async ({ manifestUrl, gameKey, versionId, baseUrl } = {}, { signal } = {}) => {
    const response = await fetch(manifestUrl, { signal });
    if (!response.ok) throw new Error('Manifest fetch failed: ' + response.status);
    const manifest = await response.json();
    if (!manifest.localPlayable) throw new Error(manifest.reason || 'This game cannot run locally');
    let assetBundle = null;
    if (manifest.assetCount > 0) {
        const origin = new URL(manifestUrl, baseUrl || window.location.href);
        const response = await fetch(new URL(manifest.assetBundleUrl, origin).href, { signal });
        if (!response.ok) throw new Error('Asset bundle fetch failed: ' + response.status);
        assetBundle = new Uint8ClampedArray(await response.arrayBuffer());
    }
    return {
        name: manifest.name,
        multiplayer: manifest.multiplayer === true,
        files: manifest.files,
        entryPoint: manifest.entryPoint,
        assetBundle,
        gameKey: gameKey || manifest.gameKey || manifest.gameId,
        versionId: versionId || manifest.versionId || manifest.commitSha,
    };
};

const loadHomeGame = ({ gameKey, versionId = null }, options) => {
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    return loadLocalGame({ gameKey, versionId,
        manifestUrl: `/games/${encodeURIComponent(gameKey)}/local-manifest${query}` }, options);
};

module.exports = { loadLocalGame, loadHomeGame };
