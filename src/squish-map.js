// Squish version → module map.
// The canonical version list lives in homegames-common (game-loader.js);
// the squish packages themselves are installed via the homegames-common
// dependency. Requires must stay static so webpack can bundle them.

const squishMap = {
    '150': require('squish-150'),
    '151': require('squish-151')
};

const DEFAULT_VERSION = '151';

module.exports = { squishMap, DEFAULT_VERSION };
