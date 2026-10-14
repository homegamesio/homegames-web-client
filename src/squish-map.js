// Squish version → module map.
// The canonical version list lives in homegames-common (game-loader.js);
// the squish packages themselves are installed via the homegames-common
// dependency. Requires must stay static so webpack can bundle them.

const squishMap = {
    '142': require('./codecs/squish-142'),
    '143': require('./codecs/squish-143'),
    '145': require('./codecs/squish-145'),
    '146': require('squish-146')
};

const DEFAULT_VERSION = '142';

module.exports = { squishMap, DEFAULT_VERSION };
