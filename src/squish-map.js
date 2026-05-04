// Map of squish version strings to their npm packages.
// The server tells us which version to use in the init message.

const squishMap = {
    '0756': require('squish-0756'),
    '0762': require('squish-0762'),
    '0765': require('squish-0765'),
    '0766': require('squish-0766'),
    '0767': require('squish-0767'),
    '1000': require('squish-1000'),
    '1004': require('squish-1004'),
    '1005': require('squish-1005'),
    '1006': require('squish-1006'),
    '1007': require('squish-1007'),
    '1009': require('squish-1009'),
    '1010': require('squish-1010'),
    '120': require('squish-120'),
    '130': require('squish-130'),
    '135': require('squish-135'),
    '136': require('squish-136'),
    '137': require('squish-137'),
    '138': require('squish-138'),
};

const DEFAULT_VERSION = '138';

module.exports = { squishMap, DEFAULT_VERSION };
