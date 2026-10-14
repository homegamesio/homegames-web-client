// Versioned scene API; lifecycle and asset I/O belong to the current host.
const codec = require('squish-143/src/squish');
const { Squisher, Asset } = require('squish-146');
module.exports = { ...codec, Asset,
    Squisher: class extends Squisher { constructor(options) { super({...options, encodeNode:codec.squish, decodeNode:codec.unsquish}); } },
    Game: require('squish-143/src/Game'),
    ViewableGame: require('squish-143/src/ViewableGame'),
    Colors: require('squish-143/src/Colors'),
    Shapes: require('squish-143/src/Shapes'),
    subtypes: require('squish-143/src/subtypes'),
    ShapeUtils: require('squish-143/src/util/shapes'),
    ViewUtils: require('squish-143/src/util/views'),
    GeometryUtils: require('squish-143/src/util/geometry'),
    Physics: require('squish-143/src/physics'),
    ...require('squish-143/src/GameNode'),
    TerrainGenerator: require('squish-143/src/terrain').terrainGenerator,
};
