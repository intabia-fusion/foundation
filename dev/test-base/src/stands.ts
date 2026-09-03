//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { resolve } from 'path'
import { type StandConfig } from './stand'
import { repoRoot } from './tool'

const PG_BOUNCER_URL = 'postgresql://postgres:postgres@localhost:6433/postgres'
// ws-tests runs every region on one postgres, one database per region (ws-tests/postgres-init).
const WS_SERVICE_DB = 'postgresql://postgres:postgres@localhost:5433/postgres'
const WS_MAIN_DB = 'postgresql://postgres:postgres@localhost:5433/region_main'
const WS_EUROPE_DB = 'postgresql://postgres:postgres@localhost:5433/region_europe'
const WS_COCKROACH_DB = 'postgresql://root@localhost:26258/defaultdb?sslmode=disable'
const LOCAL_ACCOUNTS_URL = 'http://localhost:8083/_account'
const LOCAL_REGION_CONFIG_JSON = JSON.stringify({
  regions: {
    '': {
      transactors: [{ external: 'ws://localhost:8083/_tr0', internal: 'ws://localhost:8083/_tr0' }],
      collaborators: [{ external: 'ws://localhost:8083/_cl0', internal: 'ws://localhost:8083/_cl0' }]
    }
  }
})

/** Compose overlays are opt-in per checkout; missing ones are filtered out by the stand runner. */
const PURE_PG_COMPOSE = [
  'docker-compose.yaml',
  'docker-compose.purepg.yaml',
  'docker-compose.pgbouncer.yaml',
  'docker-compose.override.versions.yml'
]

const sanity: StandConfig = {
  project: 'sanity',
  dir: 'tests',
  composeFiles: PURE_PG_COMPOSE,
  env: {
    STORAGE_CONFIG: 'datalake|http://localhost:8083/_datalake',
    ACCOUNTS_URL: LOCAL_ACCOUNTS_URL,
    PLATFORM_URL: 'http://localhost:8083',
    REGION_CONFIG_JSON: LOCAL_REGION_CONFIG_JSON,
    ACCOUNT_DB_URL: PG_BOUNCER_URL,
    DB_URL: PG_BOUNCER_URL,
    SERVER_SECRET: 'secret',
    QUEUE_CONFIG: 'localhost:19093;-staging'
  },
  accountsUrl: LOCAL_ACCOUNTS_URL,
  elasticPort: 9201,
  waitPorts: [
    ['localhost', 6433],
    ['localhost', 19093],
    ['localhost', 8083]
  ],
  cleanup: ['sanity/.auth'],
  accounts: [
    { name: 'user1', first: 'John', last: 'Appleseed' },
    { name: 'user2', first: 'Kainin', last: 'Dirak' },
    { name: 'user3', first: 'Muffin', last: 'Muram' },
    { name: 'user4', first: 'Armin', last: 'Karmin' },
    { name: 'admin', first: 'Super', last: 'User' }
  ],
  workspaces: [
    {
      name: 'sanity-ws',
      owner: 'user1',
      restore: './sanity-ws',
      members: [{ account: 'user1', role: 'OWNER' }, { account: 'user2', role: 'OWNER' }, { account: 'user3' }],
      configure: true,
      plan: 'business'
    },
    {
      name: 'meetings-ws',
      owner: 'user1',
      restore: './meetings-ws',
      members: [{ account: 'user1', role: 'OWNER' }, { account: 'user2' }, { account: 'user3' }],
      configure: true,
      plan: 'business'
    }
  ],
  post: () => [
    [
      'change-field',
      'sanity-ws',
      '--objectId',
      '65e47f1f1b875b51e3b4b983',
      '--objectClass',
      'tracker:class:Issue',
      '--attribute',
      'createdOn',
      '--value',
      `${Date.now() - 86400000}`,
      '--type',
      'number'
    ]
  ]
}

const ws: StandConfig = {
  project: 'sanity',
  dir: 'ws-tests',
  composeFiles: ['docker-compose.yaml', 'docker-compose.override.yml'],
  env: {
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    STORAGE_CONFIG: 'datalake|http://localhost:8083/_datalake',
    ACCOUNTS_URL: LOCAL_ACCOUNTS_URL,
    REGION_CONFIG: resolve(repoRoot, 'ws-tests/region-config.yaml'),
    ACCOUNT_DB_URL: WS_SERVICE_DB,
    ELASTIC_URL: 'http://localhost:9201',
    SERVER_SECRET: 'secret',
    // America region
    DB_URL: WS_MAIN_DB,
    QUEUE_CONFIG: 'localhost:19093'
  },
  regionEnv: {
    europe: {
      // Europe has no name, so it is not offered for new workspaces.
      DB_URL: WS_EUROPE_DB,
      REGION_INFO: '|America;europe|'
    }
  },
  migrations: [WS_SERVICE_DB, WS_MAIN_DB, WS_EUROPE_DB],
  accountsUrl: LOCAL_ACCOUNTS_URL,
  elasticPort: 9201,
  waitPorts: [
    ['localhost', 5433],
    ['localhost', 19093],
    ['localhost', 8083]
  ],
  cleanup: ['sanity/.auth'],
  accounts: [
    { name: 'admin', first: 'Super', last: 'Admin' },
    { name: 'user1', first: 'John', last: 'Appleseed' },
    { name: 'user2', first: 'Kainin', last: 'Dirak' },
    { name: 'user3', first: 'Muffin', last: 'Muram' },
    // user4 has no workspace membership: used to test the account-side join-time seat hard-cap.
    { name: 'user4', first: 'Seat', last: 'Joiner' },
    // billing is a read-only admin (BILLING_EMAILS): sees the admin panel, cannot mutate.
    { name: 'billing', first: 'Bill', last: 'Reader' }
  ],
  workspaces: [
    {
      name: 'api-tests',
      owner: 'user1',
      // user2 is needed by love-flow tests (caller/recipient pair) so they both
      // have PersonSpace + Employee in the same api-tests workspace.
      members: [{ account: 'user1' }, { account: 'user2' }],
      plan: 'business'
    },
    { name: 'api-tests-fail', owner: 'user3', members: [{ account: 'user3' }], plan: 'business' },
    { name: 'api-tests-cr', owner: 'user1', region: 'europe', members: [{ account: 'user1' }], plan: 'business' },
    {
      // No plan: the subscription is driven by the unpaid test itself.
      name: 'api-tests-unpaid',
      owner: 'user1',
      members: [{ account: 'user1', role: 'OWNER' }, { account: 'user2' }]
    },
    {
      // Restricted plan; users/volume unlimited.
      // Plan MUST be set before the first client connects: limits snapshot loads at pipeline boot.
      name: 'api-tests-limits',
      owner: 'user1',
      members: [{ account: 'user1' }],
      plan: 'start'
    },
    {
      // user2 + user3 are plain Users. Business has 10 seats at boot so all three members onboard;
      // the test then sets usersLimit=2 to push the last member read-only.
      name: 'api-tests-seats',
      owner: 'user1',
      members: [{ account: 'user1', role: 'OWNER' }, { account: 'user2' }, { account: 'user3' }],
      plan: 'business'
    },
    {
      // Separate ws so plan-seats-ui never races plan-seats on usersLimit.
      name: 'api-tests-seats-ui',
      owner: 'user1',
      members: [{ account: 'user1', role: 'OWNER' }, { account: 'user2' }, { account: 'user3' }],
      plan: 'business'
    },
    {
      // Unlimited at boot; the volume test tightens storage at runtime.
      name: 'api-tests-volume',
      owner: 'user1',
      members: [{ account: 'user1', role: 'OWNER' }],
      plan: 'business'
    }
  ]
}

const qms: StandConfig = {
  project: 'qms',
  dir: 'qms-tests',
  composeFiles: PURE_PG_COMPOSE,
  env: {
    STORAGE_CONFIG: 'datalake|http://localhost:8083/_datalake',
    ACCOUNTS_URL: LOCAL_ACCOUNTS_URL,
    REGION_CONFIG_JSON: LOCAL_REGION_CONFIG_JSON,
    ACCOUNT_DB_URL: PG_BOUNCER_URL,
    DB_URL: PG_BOUNCER_URL,
    SERVER_SECRET: 'secret',
    QUEUE_CONFIG: 'localhost:19093;-staging'
  },
  accountsUrl: LOCAL_ACCOUNTS_URL,
  elasticPort: 9201,
  waitPorts: [
    ['localhost', 6433],
    ['localhost', 19093],
    ['localhost', 8083]
  ],
  cleanup: ['sanity/.auth'],
  accounts: [
    { name: 'user1', first: 'John', last: 'Appleseed' },
    { name: 'user2', first: 'Kainin', last: 'Dirak' },
    // Own login rather than user3: 'Cain Velasquez' is asserted by the QMS specs, while tests/ needs
    // user3 to be 'Muffin Muram'. Both stands must be able to run on one docker stack.
    { name: 'user_cain', first: 'Cain', last: 'Velasquez' },
    { name: 'user4', first: 'Armin', last: 'Karmin' },
    { name: 'user_qara', first: 'Qara', last: 'Admin' },
    { name: 'admin', first: 'Super', last: 'User' }
  ],
  workspaces: [
    // QMS init workspace: enables all plugins for the QMS template, nobody logs into it.
    { name: 'init-ws-qms', owner: 'user1', configure: true },
    {
      name: 'sanity-ws-qms',
      owner: 'user1',
      restore: './sanity-ws-qms',
      members: [
        { account: 'user1' },
        { account: 'user2', role: 'OWNER' },
        { account: 'user_cain' },
        { account: 'user4' },
        { account: 'user_qara' }
      ],
      configure: true
    }
  ],
  post: () => [
    // Reset QMS employee active so default-space owner fill runs on first open.
    [
      'change-field',
      'sanity-ws-qms',
      '--objectId',
      '65a04887e1043543cd5f21a5',
      '--objectClass',
      'contact:class:Person',
      '--attribute',
      'contact:mixin:Employee.active',
      '--value',
      'false',
      '--type',
      'boolean'
    ]
  ]
}

/**
 * Seeds several stand definitions into one docker stack, so a single stand can serve more than one
 * test package. Containers, env and regions come from `base`; the others contribute accounts,
 * workspaces and post steps only.
 * @public
 */
export function mergeStands (base: StandConfig, ...others: StandConfig[]): StandConfig {
  const accounts = [...base.accounts]
  const workspaces = [...base.workspaces]
  const post = [base.post, ...others.map((it) => it.post)].filter((it) => it !== undefined)
  // Stale .auth storage of a merged suite would send its tests straight back to the login screen.
  const cleanup = [
    ...(base.cleanup ?? []),
    ...others.flatMap((it) => (it.cleanup ?? []).map((path) => resolve(repoRoot, it.dir, path)))
  ]

  for (const other of others) {
    for (const account of other.accounts) {
      const existing = accounts.find((it) => it.name === account.name)
      if (existing === undefined) {
        accounts.push(account)
      } else if (existing.first !== account.first || existing.last !== account.last) {
        // The name in a workspace comes from its own backup, so only the global person name differs.
        console.warn(
          `account ${account.name}: '${existing.first} ${existing.last}' from ${base.project} wins over ` +
            `'${account.first} ${account.last}' from ${other.dir}`
        )
      }
    }
    for (const workspace of other.workspaces) {
      if (workspaces.some((it) => it.name === workspace.name)) {
        throw new Error(`workspace ${workspace.name} is defined by more than one stand`)
      }
      workspaces.push({
        ...workspace,
        restore: workspace.restore !== undefined ? resolve(repoRoot, other.dir, workspace.restore) : undefined
      })
    }
  }

  return { ...base, accounts, workspaces, cleanup, post: () => post.flatMap((it) => it()) }
}

/** Same stand with the America region moved onto CockroachDB, to keep that path covered. */
const wsCockroach: StandConfig = {
  ...ws,
  composeFiles: [...ws.composeFiles, 'docker-compose.cockroach.yaml'],
  env: { ...ws.env, DB_URL: WS_COCKROACH_DB },
  migrations: [WS_SERVICE_DB, WS_COCKROACH_DB, WS_EUROPE_DB],
  waitPorts: [...(ws.waitPorts ?? []), ['localhost', 26258]]
}

/**
 * `full` runs the sanity and the QMS suites against one stand: qms-tests needs a subset of the
 * services tests/ already brings up. ws-tests stays separate - it needs a second (europe) region.
 * @public
 */
export const stands: Record<string, StandConfig> = {
  sanity,
  ws,
  'ws-cockroach': wsCockroach,
  qms,
  full: mergeStands(sanity, qms)
}
