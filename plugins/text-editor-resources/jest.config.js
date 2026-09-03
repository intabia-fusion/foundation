module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  // svelte ships ESM only; ts-jest has to transform it for a plain node test run.
  transformIgnorePatterns: ['node_modules/\\.pnpm/(?!svelte@)'],
  transform: { '^.+\\.[tj]s$': ['ts-jest', { tsconfig: { allowJs: true, target: 'es2020', module: 'commonjs' } }] }
}
