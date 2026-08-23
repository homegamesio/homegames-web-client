/**
 * Type-1 asset bundle builder for in-browser consumers (e.g. the Studio's
 * local preview). The implementation is the shared one in
 * homegames-common/local-play-shared.js — the same bytes the platform API and
 * homegames-core serve, and squish's Squisher.initialize() sends.
 */

const { packAssetBundle } = require('homegames-common/local-play-shared');

module.exports = { packAssetBundle };
