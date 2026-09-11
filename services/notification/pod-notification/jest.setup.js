// config.ts throws on import without the service's required env, and a shared jest run
// loads jest.config.js in the planner process, not in the workers that run the tests.
process.env.SOURCE = process.env.SOURCE ?? 'test@intabia.ru'
process.env.ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? 'http://localhost:3000'
process.env.SECRET = process.env.SECRET ?? 'secret'
