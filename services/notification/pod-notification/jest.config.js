// config.ts падает при импорте без обязательных переменных сервиса.
process.env.SOURCE = process.env.SOURCE ?? 'test@intabia.ru'

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  roots: ["./src"],
  coverageReporters: ["text-summary", "html"]
}
