// Versioned scene API; lifecycle and asset I/O belong to the current host.
const codec = require('squish-145/src/squish');
const { Squisher, Asset } = require('squish-146');
module.exports = { ...codec, Asset,
    Squisher: class extends Squisher { constructor(options) { super({...options, encodeNode:codec.squish, decodeNode:codec.unsquish}); } },
    Game: require('squish-145/src/Game'),
    ViewableGame: require('squish-145/src/ViewableGame'),
    Colors: require('squish-145/src/Colors'),
    Shapes: require('squish-145/src/Shapes'),
    subtypes: require('squish-145/src/subtypes'),
    ShapeUtils: require('squish-145/src/util/shapes'),
    ViewUtils: require('squish-145/src/util/views'),
    GeometryUtils: require('squish-145/src/util/geometry'),
    Physics: require('squish-145/src/physics'),
    ...require('squish-145/src/GameNode'),
    TerrainGenerator: require('squish-145/src/terrain').terrainGenerator,
};
