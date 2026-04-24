const path = require('path');

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
    mode: 'production',
};
