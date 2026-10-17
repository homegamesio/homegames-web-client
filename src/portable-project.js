// Browser adapter. Import/export are data-only; explicit trusted execution is
// used by standalone exports. Studio must not execute arbitrary imports here.
const project = require('homegames-common/portable-project');
const { prepareTrustedLocalGame } = require('homegames-common/portable-runtime');
const { squishMap } = require('./squish-map');
const options = { supportedRuntimes: Object.keys(squishMap) };
const html = require('homegames-common/portable-html');
const saves = require('homegames-common/portable-saves');
const portableClient = require('homegames-common/portable-client');

module.exports = {
    ...require('homegames-common/studio-debug'),
    ...require('homegames-common/studio-handoff'),
    create: files => project.createProject(files, options),
    importArchive: bytes => project.importArchive(bytes, options),
    exportArchive: project.exportArchive,
    withGameId: project.withGameId,
    normalizePath: project.normalizePath,
    limits: project.LIMITS,
    buildIsolatedHtml: html.buildIsolatedHtml,
    runtimeDocument: html.runtimeDocument,
    createFrame: html.createFrame,
    attachSaveHost: saves.attachSaveHost,
    attachPlayerHost: (window, frame, settings) => {
        const savesHost = saves.attachSaveHost(window, frame, settings);
        const storage = require('homegames-common/export-storage').createExportStorage(window, settings);
        const clientHost = portableClient.attachClientHost(window, frame, portableClient.recordAudio, storage,
            require('homegames-common/exports-viewer').createExportsViewer,
            require('homegames-common/video-recording').recordVideo,
            require('homegames-common/player-toolbar').createPlayerToolbar,
            { ...settings, profile: require('homegames-common/player-identity').profile(window) });
        return { ...savesHost, get stopped() { return savesHost.stopped; },
            command: clientHost.command, downloadGame: clientHost.download,
            close: async () => { clientHost.close(); await savesHost.close(); } };
    },
    connectClientSource: portableClient.connectClientSource,
    connectSaveStore: saves.connectSaveStore,
    filename: html.filename,
    readHtmlArchive: html.readHtmlArchive,
    htmlBytesLimit: html.htmlBytesLimit,
    checkSyntax: project.checkSyntax,
    thumbnailPath: project.thumbnailPath,
    prepareTrustedLocalGame: (value, settings) => prepareTrustedLocalGame(value, squishMap, settings),
};
