const path = require('path');
const webpack = require('webpack');

module.exports = {
    entry: path.join(__dirname, 'src', 'index.js'),
    output: {
        filename: 'homegames-client.js',
        path: path.resolve(__dirname, 'dist'),
        library: {
            name: 'HomegamesClient',
            type: 'umd',
            export: 'default',
        },
        globalObject: 'this',
    },
    resolve: {
        fallback: {
            "process": false,
            "path": false,
            "http": false,
            "https": false,
            "crypto": false,
            "fs": false,
        }
    },
    plugins: [
        // The squish Squisher (used by LocalSession) builds asset bundles with
        // Buffer, which browsers don't have. Resolve the polyfill absolutely —
        // squish is file-linked from outside this package, so relative
        // resolution from its files can't find our node_modules.
        new webpack.ProvidePlugin({
            Buffer: [require.resolve('buffer/'), 'Buffer'],
        }),
    ],
    mode: 'production',
};
