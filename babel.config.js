/**
 * Metro does not need this file on SDK 57, but jest-expo's babel transform
 * does. Keeping it here means `npm test` works on a clean clone.
 */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
