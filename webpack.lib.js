const webpack = require('webpack');
const nodeExternals = require('webpack-node-externals');
const { compilerOptions } = require('./tsconfig.json');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';

const envPlugin = new webpack.EnvironmentPlugin({
    NODE_ENV: '',
    NODE_NO_WARNINGS: '',
});

const rules = [
    {
        test: /\.node$/,
        use: 'node-loader',
    },
    {
        test: /\.tsx?$/,
        exclude: /(node_modules|.webpack)/,
        rules: [
            {
                loader: 'ts-loader',
                options: {
                    transpileOnly: true,
                },
            },
        ],
    },
];

module.exports = [
    {
        mode: isProd ? 'production' : 'development',
        entry: {
            index: path.join(__dirname, 'src', 'index.ts'),
        },
        target: 'node',
        devtool: 'source-map',
        // externals: [nodeExternals()],
        resolve: {
            extensions: ['.ts', '.js', '.png', '.svg'],
            // modules: [path.resolve('./node_modules'), path.resolve(__dirname, compilerOptions.baseUrl)],
        },
        node: {
            __dirname: true,
        },
        module: {
            rules: [...rules],
        },
        output: {
            path: __dirname + '/dist',
            filename: `index.js`,
            library: {
                name: "zkitterjs",
                type: "umd"
            },
        },
        plugins: [envPlugin],
    },
];
