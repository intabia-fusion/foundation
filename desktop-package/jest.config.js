module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__test__/**/*.test.ts'],
  roots: ['./src'],
  coverageReporters: ['text-summary', 'html']
}
