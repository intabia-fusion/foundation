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

import { getClient as getAccountClient } from '@hcengineering/account-client'
import { existsSync, rmSync } from 'fs'
import { resolve } from 'path'
import { composeDown, composeUp, exec, waitElastic, waitFor, waitTcp } from './docker'
import { initLogs, log, parallel, phase } from './log'
import { applyEnv, getModelVersionString, repoRoot, runTool, warmupTool, type ToolEnv } from './tool'

/**
 * @public
 */
export interface AccountSpec {
  name: string
  first: string
  last: string
  password?: string
}

/**
 * @public
 */
export interface MemberSpec {
  account: string
  role?: 'OWNER' | 'MAINTAINER' | 'USER' | 'GUEST'
}

/**
 * @public
 */
export interface WorkspaceSpec {
  name: string
  owner: string
  region?: string
  /** Backup directory to restore into the workspace, relative to the stand directory. */
  restore?: string
  members?: MemberSpec[]
  configure?: boolean
  plan?: string
  /** Skip the post-setup login check (workspaces intentionally left without members). */
  skipVerify?: boolean
}

/**
 * @public
 */
export interface StandConfig {
  /** Docker compose project name. */
  project: string
  /** Stand directory with the compose files, relative to the repository root. */
  dir: string
  composeFiles: string[]
  /** Tool env for the default region. */
  env: ToolEnv
  /** Tool env overrides per workspace region. */
  regionEnv?: Record<string, ToolEnv>
  /** DB urls to run the db-migrator against before seeding. */
  migrations?: string[]
  accountsUrl: string
  elasticPort?: number
  waitPorts?: Array<[string, number]>
  accounts: AccountSpec[]
  workspaces: WorkspaceSpec[]
  /** Extra tool commands executed after the workspaces are seeded. */
  post?: () => string[][]
  /** Paths removed before the stand starts, relative to the stand directory. */
  cleanup?: string[]
  concurrency?: number
}

function standDir (cfg: StandConfig): string {
  return resolve(repoRoot, cfg.dir)
}

function envFor (cfg: StandConfig, region?: string): ToolEnv {
  const base = { ...cfg.env, MODEL_VERSION: getModelVersionString() }
  if (region === undefined || region === '') return base
  const override = cfg.regionEnv?.[region]
  if (override === undefined) {
    throw new Error(`stand ${cfg.project} has no env for region ${region}`)
  }
  return { ...base, ...override }
}

/** Workspaces grouped by region: one env is active per phase, so regions cannot interleave. */
function byRegion (workspaces: WorkspaceSpec[]): Array<[string, WorkspaceSpec[]]> {
  const groups = new Map<string, WorkspaceSpec[]>()
  for (const ws of workspaces) {
    const key = ws.region ?? ''
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [ws])
    else list.push(ws)
  }
  return [...groups.entries()]
}

function composeOptions (cfg: StandConfig): { cwd: string, project: string, files: string[] } {
  const cwd = standDir(cfg)
  return { cwd, project: cfg.project, files: cfg.composeFiles.filter((f) => existsSync(resolve(cwd, f))) }
}

async function waitServices (cfg: StandConfig): Promise<void> {
  const waits: Array<Promise<void>> = (cfg.waitPorts ?? []).map(async ([host, port]) => {
    await waitTcp(host, port)
  })
  if (cfg.elasticPort !== undefined) {
    waits.push(waitElastic(cfg.elasticPort))
  }
  await Promise.all(waits)
}

async function runMigrations (cfg: StandConfig): Promise<void> {
  const migrator = resolve(repoRoot, 'services/db-migrator/lib/index.js')
  await Promise.all(
    (cfg.migrations ?? []).map(async (dbUrl) => {
      const db = dbUrl.slice(dbUrl.lastIndexOf('/') + 1).split('?')[0]
      await exec('node', [migrator], { cwd: standDir(cfg), env: { DB_URL: dbUrl }, prefix: `migrate ${db}` })
    })
  )
}

async function createAccounts (cfg: StandConfig, concurrency: number): Promise<void> {
  applyEnv(envFor(cfg))
  await parallel(cfg.accounts, concurrency, async (acc) => {
    await runTool(['create-account', acc.name, '-f', acc.first, '-l', acc.last, '-p', acc.password ?? '1234'])
  })
}

async function createWorkspaces (cfg: StandConfig, concurrency: number): Promise<void> {
  for (const [region, workspaces] of byRegion(cfg.workspaces)) {
    applyEnv(envFor(cfg, region))
    await parallel(workspaces, concurrency, async (ws) => {
      const args = ['create-workspace', ws.name, `email:${ws.owner}`]
      if (region !== '') args.push('--region', region)
      await runTool(args)
    })
  }
}

async function seedWorkspaces (cfg: StandConfig, concurrency: number): Promise<void> {
  for (const [region, workspaces] of byRegion(cfg.workspaces)) {
    applyEnv(envFor(cfg, region))

    // Restores run one at a time on purpose: the model upgrade inside `--upgrade` holds a DB cursor
    // while issuing further queries, and running three of those at once deadlocks on pgbouncer.
    for (const ws of workspaces) {
      if (ws.restore !== undefined) {
        // Backups live next to the stand that defined the workspace, which is not the cwd once
        // stands are merged.
        await runTool(['backup-restore', resolve(standDir(cfg), ws.restore), ws.name, '--upgrade'])
      }
    }

    await parallel(workspaces, concurrency, async (ws) => {
      for (const member of ws.members ?? []) {
        await runTool(['assign-workspace', member.account, ws.name])
      }
      for (const member of ws.members ?? []) {
        if (member.role !== undefined) {
          await runTool(['set-user-role', member.account, ws.name, member.role])
        }
      }
      if (ws.configure === true) {
        await runTool(['configure', ws.name, '--enable=*'])
      }
      if (ws.plan !== undefined) {
        await runTool(['set-workspace-plan', ws.name, ws.plan])
      }
    })
  }
}

async function verifyStand (cfg: StandConfig): Promise<void> {
  for (const ws of cfg.workspaces) {
    // Membership is explicit: a workspace with no members has nobody who could log into it.
    const account = ws.members?.[0]?.account
    if (ws.skipVerify === true || account === undefined) continue
    const password = cfg.accounts.find((a) => a.name === account)?.password ?? '1234'
    await waitFor(`workspace ${ws.name}`, async () => {
      const login = await getAccountClient(cfg.accountsUrl).login(account, password)
      if (login?.token == null) return false
      const info = await getAccountClient(cfg.accountsUrl, login.token).selectWorkspace(ws.name)
      if (info?.endpoint == null) return false
      // Asking the transactor boots the workspace pipeline: a broken region schema fails here rather
      // than in the tests, and the tests do not all pay the cold start at once.
      const res = await fetch(`${info.endpoint.replace(/^ws/, 'http')}/api/v1/account/${info.workspace as string}`, {
        headers: { Authorization: `Bearer ${info.token}` }
      })
      return res.ok
    })
  }
}

/**
 * @public
 */
export async function prepareStand (cfg: StandConfig): Promise<void> {
  const concurrency = cfg.concurrency ?? 3
  initLogs(resolve(standDir(cfg), 'sanity/logs/prepare'))
  log(`Preparing stand '${cfg.project}' in ${cfg.dir}`)

  const compose = composeOptions(cfg)
  for (const path of cfg.cleanup ?? []) {
    rmSync(resolve(compose.cwd, path), { recursive: true, force: true })
  }

  await phase('docker down', async () => {
    await composeDown(compose)
  })

  // `up` waits on container healthchecks in its own process, so the model can be built meanwhile.
  const up = phase('docker up', async () => {
    await composeUp(compose)
  })
  // Held until the await below: if the warmup throws first, `up` is never awaited and its rejection
  // would otherwise surface as an unhandled one.
  up.catch(() => {})
  applyEnv(envFor(cfg))
  await phase('tool warmup', async () => {
    warmupTool()
  })
  await up

  await phase('services ready', async () => {
    await waitServices(cfg)
  })
  if ((cfg.migrations ?? []).length > 0) {
    await phase('db migrations', async () => {
      await runMigrations(cfg)
    })
  }
  await phase(`accounts (${cfg.accounts.length})`, async () => {
    await createAccounts(cfg, concurrency)
  })
  await phase(`workspaces (${cfg.workspaces.length})`, async () => {
    await createWorkspaces(cfg, concurrency)
  })
  await restoreStand(cfg)
}

/**
 * Re-seeds the workspaces of a running stand: backup restore, membership, roles, plans. Used to reset
 * a stand to its baseline between test runs without recreating the containers.
 * @public
 */
export async function restoreStand (cfg: StandConfig): Promise<void> {
  const concurrency = cfg.concurrency ?? 3
  initLogs(resolve(standDir(cfg), 'sanity/logs/prepare'))
  await phase('workspace data', async () => {
    await seedWorkspaces(cfg, concurrency)
  })
  const post = cfg.post?.() ?? []
  if (post.length > 0) {
    await phase('post steps', async () => {
      applyEnv(envFor(cfg))
      for (const args of post) {
        await runTool(args)
      }
    })
  }
  await phase('verify stand', async () => {
    await verifyStand(cfg)
  })
  log(`Stand '${cfg.project}' is ready`)
}
