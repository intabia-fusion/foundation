module.exports = {
  preset: 'ts-jest',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  roots: ["./src"],
  coverageReporters: ["text-summary", "html"]
}
