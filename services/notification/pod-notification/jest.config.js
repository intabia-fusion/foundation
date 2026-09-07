// config.ts падает при импорте без обязательных переменных сервиса.
process.env.SOURCE = process.env.SOURCE ?? 'test@intabia.ru'
process.env.ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? 'http://localhost:3000'
process.env.SECRET = process.env.SECRET ?? 'secret'

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  roots: ["./src"],
  coverageReporters: ["text-summary", "html"]
}
