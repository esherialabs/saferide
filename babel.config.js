module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    env: {
      // Metro builds release bundles with BABEL_ENV=production. Release builds
      // must not write app or dependency console output to device logs, which
      // other apps or a connected computer can read.
      production: {
        plugins: ['transform-remove-console'],
      },
    },
  };
};
