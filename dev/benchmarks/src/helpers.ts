/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import {
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type RestClient,
  type ServerConfig,
  type WorkspaceToken
} from '@hcengineering/api-client'
import core, {
  generateId,
  MeasureMetricsContext,
  pickPrimarySocialId,
  TxOperations,
  type Ref,
  type SocialId,
  type Space
} from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import contact, { ensureEmployee } from '@hcengineering/contact'
import tracker, { type Issue, IssuePriority, type Project } from '@hcengineering/tracker'
import { makeRank } from '@hcengineering/rank'

import type { BenchConfig } from './config'

// Stats

export interface StepStats {
  label: string
  count: number
  succeeded: number
  failed: number
  wallMs: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  realOpsPerSec: number
  errors: Map<string, number>
}

export function calcStats (label: string, timings: number[], wallMs: number, errors: Map<string, number>): StepStats {
  const failCount = errors.size > 0 ? [...errors.values()].reduce((a, b) => a + b, 0) : 0
  if (timings.length === 0) {
    return {
      label,
      count: failCount,
      succeeded: 0,
      failed: failCount,
      wallMs: Math.round(wallMs),
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      realOpsPerSec: 0,
      errors
    }
  }
  const sorted = [...timings].sort((a, b) => a - b)
  const total = sorted.reduce((a, b) => a + b, 0)
  const count = sorted.length + failCount
  return {
    label,
    count,
    succeeded: sorted.length,
    failed: failCount,
    wallMs: Math.round(wallMs),
    avgMs: Math.round(total / sorted.length),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted[sorted.length - 1]),
    p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
    p99Ms: Math.round(sorted[Math.floor(sorted.length * 0.99)]),
    realOpsPerSec: wallMs > 0 ? Math.round((sorted.length / wallMs) * 1000) : 0,
    errors
  }
}

export function printStats (s: StepStats): void {
  console.log(
    `  [${s.label}] ok=${s.succeeded} fail=${s.failed} wall=${s.wallMs}ms ` +
      `avg=${s.avgMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms p99=${s.p99Ms}ms max=${s.maxMs}ms ` +
      `ops/s=${s.realOpsPerSec}`
  )
  if (s.errors.size > 0) {
    for (const [msg, cnt] of s.errors) {
      console.log(`    [${cnt}x] ${msg}`)
    }
  }
}

export function trackError (errors: Map<string, number>, err: any): void {
  const msg = String(err?.message ?? err).slice(0, 120)
  errors.set(msg, (errors.get(msg) ?? 0) + 1)
}

// Connection pool

export interface ConnectionPool {
  config: ServerConfig
  wsToken: WorkspaceToken
  socialIds: SocialId[]
}

export async function initPool (cfg: BenchConfig): Promise<ConnectionPool> {
  const config = await loadServerConfig(cfg.url)
  const wsToken = await getWorkspaceToken(cfg.url, {
    email: cfg.email,
    password: cfg.password,
    workspace: cfg.workspace
  }, config)

  const accountClient = getAccountClient(config.ACCOUNTS_URL, wsToken.token)
  const person = await accountClient.getPerson()
  const socialIds: SocialId[] = await accountClient.getSocialIds(true)

  const testCtx = new MeasureMetricsContext('bench', {})
  const restClient = makeRestClient(wsToken)

  await ensureEmployee(
    testCtx,
    {
      uuid: wsToken.info.account,
      role: wsToken.info.role,
      primarySocialId: pickPrimarySocialId(socialIds)._id,
      socialIds: socialIds.map((si) => si._id),
      fullSocialIds: socialIds
    },
    restClient,
    socialIds,
    async () => person
  )

  return { config, wsToken, socialIds }
}

export function makeRestClient (wsToken: WorkspaceToken): RestClient {
  return createRestClient(wsToken.endpoint, wsToken.workspaceId, wsToken.token)
}

export function makeRestClients (wsToken: WorkspaceToken, count: number): RestClient[] {
  return Array.from({ length: count }, () => makeRestClient(wsToken))
}

export async function makeTxClient (wsToken: WorkspaceToken): Promise<TxOperations> {
  return await createRestTxOperations(wsToken.endpoint, wsToken.workspaceId, wsToken.token)
}

// Project helpers

export async function ensureProject (
  conn: RestClient,
  txOps: TxOperations,
  identifier: string,
  name: string
): Promise<Project> {
  let project = await conn.findOne(tracker.class.Project, { identifier })
  if (project !== undefined) {
    return project
  }

  await txOps.createDoc(
    tracker.class.Project,
    core.space.Model as unknown as Ref<Space>,
    {
      name,
      description: '',
      private: false,
      archived: false,
      members: [],
      autoJoin: false,
      identifier,
      sequence: 0,
      defaultIssueStatus: tracker.status.Backlog,
      defaultTimeReportDay: 0,
      type: tracker.descriptors.ProjectType
    } as any
  )

  project = await conn.findOne(tracker.class.Project, { identifier })
  if (project === undefined) {
    throw new Error(`Failed to create project ${identifier}`)
  }
  return project
}

export async function allocateSequences (
  conn: RestClient,
  project: Project,
  count: number
): Promise<number> {
  const incResult = await conn.update(project, { $inc: { sequence: count } } as any, true)
  return ((incResult as any).object?.sequence ?? project.sequence) - count + 1
}

export function generateRanks (count: number): string[] {
  const ranks: string[] = []
  let last: string | undefined
  for (let i = 0; i < count; i++) {
    const rank = makeRank(last, undefined)
    ranks.push(rank)
    last = rank
  }
  return ranks
}

export async function createIssue (
  conn: RestClient,
  project: Project,
  sequence: number,
  rank: string,
  title?: string
): Promise<Ref<Issue>> {
  const issueId: Ref<Issue> = generateId()
  await conn.addCollection(
    tracker.class.Issue,
    project._id,
    project._id,
    project._class,
    'issues',
    {
      title: title ?? `Issue #${sequence}`,
      description: null,
      status: project.defaultIssueStatus,
      number: sequence,
      kind: tracker.taskTypes.Issue,
      identifier: `${project.identifier}-${sequence}`,
      priority: IssuePriority.NoPriority,
      assignee: null,
      component: null,
      estimation: 0,
      remainingTime: 0,
      reportedTime: 0,
      reports: 0,
      subIssues: 0,
      parents: [],
      childInfo: [],
      dueDate: null,
      rank
    } as any,
    issueId
  )
  return issueId
}
