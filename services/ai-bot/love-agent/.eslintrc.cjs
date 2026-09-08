module.exports = {
  "extends": [
    "../../../foundations/utils/packages/platform-rig/profiles/node/eslint.config.json"
  ],
  "ignorePatterns": ["*.json", "node_modules/*", ".eslintrc.cjs", "esbuild.config.js"],
  "rules": {
    "@typescript-eslint/array-type": "off",
    "@typescript-eslint/promise-function-async": "off",
    "@typescript-eslint/consistent-type-imports": "off"
  },
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  }
}