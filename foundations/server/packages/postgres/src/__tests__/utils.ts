import type { DBClient } from '@hcengineering/postgres-base'

export interface TypedQuery {
  query: string
  params?: any[]
}
export function createDummyClient (queries: TypedQuery[]): DBClient {
  const client: DBClient = {
    execute: async (query, params) => {
      queries.push({ query, params })
      return Object.assign([], { count: 0 })
    },
    raw: () => jest.fn() as any,
    reserve: async () => client,
    release: jest.fn()
  }
  return client
}

// Swaps the database in a connection URI. The pg URL carries it as the last path segment,
// so the old `replace('defaultdb', ...)` silently did nothing and tests shared one database.
export function withDatabase (uri: string, db: string): string {
  const u = new URL(uri)
  u.pathname = '/' + db
  return u.toString()
}
