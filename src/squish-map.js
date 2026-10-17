// Squish version → module map.
// The canonical version list lives in homegames-common (game-loader.js);
// the squish packages themselves are installed via the homegames-common
// dependency. Requires must stay static so webpack can bundle them.

const squishMap = {
    '150': require('squish-150')
};

const DEFAULT_VERSION = '150';

module.exports = { squishMap, DEFAULT_VERSION };
