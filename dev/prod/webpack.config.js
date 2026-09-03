//
// Copyright © 2020 Anticrm Platform Contributors.
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Load sass-quiet FIRST to install stderr filter
const sass = require('../../common/scripts/sass-quiet.js')

const Dotenv = require('dotenv-webpack')
const path = require('path')
const CompressionPlugin = require('compression-webpack-plugin')
const DefinePlugin = require('webpack').DefinePlugin
const ContextReplacementPlugin = require('webpack').ContextReplacementPlugin
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const { Configuration } = require('webpack')

const mode = process.env.NODE_ENV || 'development'
const prod = mode === 'production'
const clientType = process.env.CLIENT_TYPE ?? ''
const devServer = clientType === 'dev-server'
const devServerTest = clientType === 'dev-server-test'
const devServerWorker = clientType === 'dev-worker'
const devServerWorkerLocal = clientType === 'dev-worker-local'
const devProduction = clientType === 'dev-production'
const devProductionHuly = clientType === 'dev-huly'
const devProductionBold = clientType === 'dev-bold'
const dev =
  (process.env.CLIENT_TYPE ?? '') === 'dev' ||
  devServer ||
  devProduction ||
  devProductionHuly ||
  devProductionBold ||
  devServerWorker ||
  devServerWorkerLocal ||
  devServerTest
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin')

const doValidate = !prod || process.env.DO_VALIDATE === 'true'

const doCompression = prod

const useCache = process.env.USE_CACHE === 'true'

const doAnalyze = process.env.DO_ANALYZE === 'true'
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin

const StatoscopeWebpackPlugin = require('@statoscope/webpack-plugin').default;


const devProxy = {
  '/_account': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_tr': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_cl': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_rekoni': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_stats': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_datalake': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_stream': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_preview': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_billing': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_payment': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_ai': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_love': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_print': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_sign': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_export': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_link-preview': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_mail': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_fulltext': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/files': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/api/v1': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/import': {
    target: 'http://localhost:8087',
    changeOrigin: true,
    logLevel: 'debug'
  }
}

const devProxyTest = {
  '/_account': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_tr': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_cl': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    ws: true,
    logLevel: 'debug'
  },
  '/_rekoni': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_stats': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_datalake': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_stream': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_fulltext': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_billing': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/_payment': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/files': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/api/v1': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/import': {
    target: 'http://localhost:8083',
    changeOrigin: true,
    logLevel: 'debug'
  }
}

const devHulyProxy = {
  '/account': {
    target: 'https://platform.intabia.ru/_account',
    changeOrigin: true,
    pathRewrite: { '^/account': '' },
    logLevel: 'debug'
  },
  '/api/v1': {
    target: 'http://platform.intabia.ru',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/files': {
    target: 'https://platform.intabia.ru/files',
    changeOrigin: true,
    pathRewrite: { '^/files': '' },
    logLevel: 'debug'
  },
  '/rekoni/recognize': {
    target: 'https://platform.intabia.ru/_rekoni',
    changeOrigin: true,
    pathRewrite: { '^/rekoni/recognize': '/recognize' },
    logLevel: 'debug'
  }
}

const devBoldProxy = {
  '/account': {
    target: 'https://account.bold.ru/',
    changeOrigin: true,
    pathRewrite: { '^/account': '' },
    logLevel: 'debug'
  },
  '/files': {
    target: 'https://app.bold.ru/files',
    changeOrigin: true,
    pathRewrite: { '^/files': '' },
    logLevel: 'debug'
  },
  '/api/v1': {
    target: 'http://app.bold.ru',
    changeOrigin: true,
    logLevel: 'debug'
  },
  '/rekoni/recognize': {
    target: 'https://rekoni.bold.ru',
    changeOrigin: true,
    pathRewrite: { '^/rekoni/recognize': '/recognize' },
    logLevel: 'debug'
  }
}

const devFrontProxy = {
  '/account': {
    target: 'https://account.hc.engineering/',
    changeOrigin: true,
    pathRewrite: { '^/account': '' },
    logLevel: 'debug'
  },
  '/files': {
    target: 'https://front.hc.engineering/files',
    changeOrigin: true,
    pathRewrite: { '^/files': '' },
    logLevel: 'debug'
  },
  '/rekoni/recognize': {
    target: 'https://rekoni.hc.enigneering',
    changeOrigin: true,
    pathRewrite: { '^/rekoni/recognize': '/recognize' },
    logLevel: 'debug'
  }
}

const proxy = {
  'dev-worker': devProxy,
  'dev-worker-local': devProxy,
  'dev-server': devProxy,
  'dev-server-test': devProxyTest,
  'dev-production': devFrontProxy,
  'dev-bold': devBoldProxy,
  'dev-platform': devHulyProxy
}

/**
 * @type {Configuration}
 */
const cacheConfig = (name) => useCache
  ? {
    type: 'filesystem',
    allowCollectingMemory: true,
    compression: 'gzip',
    cacheLocation: path.resolve(__dirname, `.build_dev/${name}`),
    buildDependencies: {
      config: [__filename, path.resolve(__dirname, 'package.json')]
    }
  }
  : { type: 'memory' }

const snapshotConfig = {
  managedPaths: [path.resolve(__dirname, '../../node_modules'), path.resolve(__dirname, 'node_modules')],
  buildDependencies: { hash: true, timestamp: false },
  module: { hash: true, timestamp: false },
  resolve: { hash: true, timestamp: false }
}

module.exports = [
  {
    mode: dev ? 'development' : mode,
    cache: cacheConfig('sw'),
    snapshot: snapshotConfig,
    entry: {
      serviceWorker: '@hcengineering/notification/src/serviceWorker.ts'
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /(node_modules|\.webpack)/,
          use: {
            loader: 'esbuild-loader',
            options: {
              target: 'es2022',
              keepNames: true,
              minify: prod,
              sourcemap: !prod
            }
          }
        }
      ]
    },
    output: {
      path: __dirname + '/dist',
      filename: '[name].js',
      chunkFilename: '[name].js',
      publicPath: '/',
      pathinfo: false,
      hashFunction: 'xxhash64'
    },
    resolve: {
      extensions: ['.ts', '.js'],
      conditionNames: ['svelte', 'browser', 'import']
    }
  },
  {
    cache: cacheConfig('main'),
    snapshot: snapshotConfig,
    parallelism: 100,
    entry: {
      bundle: ['@hcengineering/theme/styles/global.scss',
        ...(dev ? ['./src/main-dev.ts'] : ['./src/main.ts'])
      ]
    },
    ignoreWarnings: [
      {
        message: /a11y-/
      },
      /warning from compiler/,
      (warning) => true
    ],
    resolve: {
      symlinks: true,
      alias: {
        svelte: path.resolve('node_modules', 'svelte/src/runtime'),
        '@hcengineering/platform-rig/profiles/ui/svelte': path.resolve('node_modules', 'svelte/src/runtime')
      },
      fallback: {
        crypto: false
      },
      extensions: ['.mjs', '.js', '.svelte', '.ts'],
      mainFields: ['svelte', 'browser', 'module', 'main'],
      conditionNames: ['svelte', 'browser', 'import']
    },
    output: {
      path: __dirname + '/dist',
      filename: '[name].[contenthash].js',
      publicPath: '/',
      pathinfo: false,
      asyncChunks: true,
      hashFunction: 'xxhash64'
    },
    optimization: {
      minimize: prod,
      //moduleIds: 'named',
      chunkIds: prod ? 'deterministic' : 'named',
      // chunkIds: 'named',
      splitChunks: {
        chunks: 'all',
        cacheGroups: {
          'vendors-livekit': {
            test: /[\\/]node_modules[\\/](@livekit\/krisp-noise-filter|@livekit\/track-processors|livekit-client)[\\/]/,
            name: 'vendors-livekit',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 11, // Высокий приоритет, чтобы перехватить модули до других групп
          },
          'vendors-editors': {
            test: /[\\/]node_modules[\\/](@tiptap|.*prosemirror.*|yjs|y-protocols)[\\/]/,
            name: 'vendors-editors',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 12, // Высокий приоритет, чтобы перехватить модули до других групп
          },

          'media-plyr': {
            test: /[\\/]node_modules[\\/](plyr)[\\/]/,
            name: 'media-plyr',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 14, // Высокий приоритет, чтобы перехватить модули до других групп
          },
          'autolinker': {
            test: /[\\/]node_modules[\\/](autolinker)[\\/]/,
            name: 'autolinker',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 14, // Высокий приоритет, чтобы перехватить модули до других групп
          },

          'mermaid': {
            test: /[\\/]node_modules[\\/](mermaid|@mermaid-js|khroma|dayjs|katex|cytoscape)[\\/]/,
            name: 'mermaid',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 15, // Высокий приоритет, чтобы перехватить модули до других групп
          },
          'd3': {
            test: /[\\/]node_modules[\\/](d3|d3-)[\\/]/,
            name: 'd3',
            reuseExistingChunk: true,
            chunks: 'all',
            priority: 15, // Высокий приоритет, чтобы перехватить модули до других групп
          },

          // Group translation files by language (includes github-assets/lang, etc.)
          translations: {
            test: /[\\/]lang[\\/]([a-z-]+)\.json$/,
            type: 'json',
            priority: -5,
            enforce: true,
            reuseExistingChunk: true,
            name(module, chunks, cacheGroupKey) {
              // Extract language code from path (e.g., /lang/en.json -> en)
              const match = module.resource?.match(/[\\/]lang[\\/]([a-z-]+)\.json$/)
              const lang = match ? match[1] : 'unknown'
              return `lang-${lang}`
            }
          },
          // Emojibase data - separate chunks by language
          emojiData: {
            test: /[\\/]node_modules[\\/]emojibase-data[\\/]/,
            type: 'json',
            priority: 3,
            reuseExistingChunk: true,
            name(module, chunks, cacheGroupKey) {
              // Extract language from path: emojibase-data/en/data.json -> emoji-data-en
              const match = module.resource?.match(/emojibase-data[\\/]([a-z-]+)[\\/]/)
              const lang = match ? match[1] : 'unknown'
              return `emoji-data-${lang}`
            },
            minSize: 0
          },
          // Bundle all *-assets plugins into single chunk
          'bundle-assets': {
            test: /[\\/]([^\\/]*-assets)[\\/]/,
            name: 'bundle-assets',
            priority: 4,
            reuseExistingChunk: true,
            minSize: 0
          },
        }
      }
    },
    module: {
      rules: [
        {
          test: /\.m?js$/,
          resolve: {
            fullySpecified: false
          }
        },
        {
          test: /\.ts?$/,
          loader: 'esbuild-loader',
          options: {
            target: 'es2022',
            keepNames: true,
            minify: prod,
            sourcemap: true
          },
          exclude: /node_modules/
        },
        {
          test: /\.svelte$/,
          use: [
            {
              loader: 'svelte-loader',
              options: {
                compilerOptions: {
                  dev: !prod
                },
                emitCss: true,
                hotReload: !prod,
                preprocess: require('svelte-preprocess')({
                  postcss: true,
                  sourceMap: true,
                  scss: {
                    implementation: sass
                  }
                }),
                hotOptions: {
                  // Prevent preserving local component state
                  preserveLocalState: true,

                  // If this string appears anywhere in your component's code, then local
                  // state won't be preserved, even when noPreserveState is false
                  noPreserveStateKey: '@!hmr',

                  // Prevent doing a full reload on next HMR update after fatal error
                  noReload: true,

                  // Try to recover after runtime errors in component init
                  optimistic: false,

                  // --- Advanced ---

                  // Prevent adding an HMR accept handler to components with
                  // accessors option to true, or to components with named exports
                  // (from <script context="module">). This have the effect of
                  // recreating the consumer of those components, instead of the
                  // component themselves, on HMR updates. This might be needed to
                  // reflect changes to accessors / named exports in the parents,
                  // depending on how you use them.
                  acceptAccessors: true,
                  acceptNamedExports: true
                }
              }
            }
          ]
        },
        {
          test: /\.css$/,
          use: [
            prod ? MiniCssExtractPlugin.loader : 'style-loader',
            'css-loader',
            'postcss-loader'
          ]
        },

        {
          test: /\.scss$/,
          use: [
            prod ? MiniCssExtractPlugin.loader : 'style-loader',
            'css-loader',
            'postcss-loader',
            {
              loader: "sass-loader",
              options: {
                api: "modern",
                implementation: sass
              }
            }
          ]
        },

        {
          test: /\.(ttf|otf|eot|woff|woff2)$/,
          use: {
            loader: 'file-loader',
            options: {
              name: 'fonts/[hash:base64:8].[ext]',
              esModule: false
            }
          }
        },
        {
          test: /\.(jpg|png|webp|heic|avif)$/,
          use: {
            loader: 'file-loader',
            options: {
              name: 'img/[contenthash].[ext]',
              esModule: false
            }
          }
        },
        {
          test: /\.(wav|ogg)$/,
          use: {
            loader: 'file-loader',
            options: {
              name: 'snd/[contenthash].[ext]',
              esModule: false
            }
          }
        },
        {
          test: /\.svg$/,
          use: [
            {
              loader: 'file-loader',
              options: {
                name: 'img/[contenthash].[ext]',
                esModule: false
              }
            },
            {
              loader: 'svgo-loader',
              options: {
                plugins: [
                  { name: 'removeHiddenElems', active: false }
                  // { removeHiddenElems: { displayNone: false } },
                  // { cleanupIDs: false },
                  // { removeTitle: true }
                ]
              }
            }
          ]
        }
      ]
    },
    mode,
    plugins: [
      ...(doAnalyze ? [new StatoscopeWebpackPlugin()] : []),
      // ...(doAnalyze
      //   ? [
      //       new BundleAnalyzerPlugin({
      //         analyzerMode: 'static',
      //         openAnalyzer: false
      //       })
      //     ]
      //   : []),
      new HtmlWebpackPlugin({
        meta: {
          viewport: 'width=device-width, initial-scale=1.0'
        }
      }),
      ...(prod
        ? [new MiniCssExtractPlugin({
          filename: '[name].[contenthash].css',
          chunkFilename: '[name].[contenthash].css'
        })]
        : []),
      ...(doCompression
        ? [
          new CompressionPlugin({
            filename: '[path][base].gz',
            algorithm: 'gzip',
          }),
          new CompressionPlugin({
            filename: '[path][base].br',
            algorithm: 'brotliCompress',
            compressionOptions: { level: 11 }
          })
        ]
        : []),
      new Dotenv({ path: prod ? '.env-prod' : '.env' }),
      new DefinePlugin({
        'process.env.CLIENT_TYPE': JSON.stringify(process.env.CLIENT_TYPE)
      }),
      new ContextReplacementPlugin(/emojibase-data/, /^\.\/(en|ru|de|es|es-mx|fr|it|ja|pt|zh)(\/.*)?\.json$/),
      ...(doValidate ? [new ForkTsCheckerWebpackPlugin()] : [])
    ],
    watchOptions: {
      // for some systems, watching many files can result in a lot of CPU or memory usage
      // https://webpack.js.org/configuration/watch/#watchoptionsignored
      // don't use this pattern, if you have a monorepo with linked packages
      ignored: [
        '**/node_modules',
        '**/.git',
        '**/common/temp',
        '**/.rush',
        '**/.rush/**',
        '**/rush-logs',
        '**/lib/*.js',
        '**/lib/*.js.map',
        '**/types/*.d.ts',
        '**/.git/objects/**',
        '**/node_modules/**',
        '**/desktop/deploy/**',
        '**/dist/**',
        '**/.validate/**',
        '**/.format/**',
        '**/.build_dev/**'
      ],
      aggregateTimeout: 100,
      followSymlinks: false,
      poll: 250
    },
    devtool: prod ? 'source-map' : 'eval-source-map', // 'inline-source-map',
    devServer: {
      static: {
        directory: path.resolve(__dirname, 'public'),
        publicPath: '/',
        serveIndex: true,
        watch: true
      },
      historyApiFallback: {
        disableDotRule: true
      },
      host: '0.0.0.0',
      allowedHosts: 'all',
      hot: true,
      client: {
        logging: 'info',
        overlay: {
          errors: true,
          warnings: false,
          runtimeErrors: (error) => {
            if (error.message.includes('ResizeObserver')) {
              return false
            }
            return true
          }
        },
        progress: false
      },
      proxy: proxy[clientType]
    }
  }
]
