const { createSessionRuntime } = require('homegames-common/session-runtime');
module.exports = (codec, game, options = {}) => createSessionRuntime(codec, game, { ...options, loadAssets: false });
