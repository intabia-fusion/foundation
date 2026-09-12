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

import core, {
  MeasureMetricsContext,
  pickPrimarySocialId,
  TxOperations,
  type Ref
} from '@hcengineering/core'
import {
  createRestClient,
  createRestTxOperations,
  loadServerConfig,
  type RestClient
} from '@hcengineering/api-client'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { ensureEmployee } from '@hcengineering/contact'
import tracker, { type Issue, type Project } from '@hcengineering/tracker'

import type { BenchConfig } from '../config'
import {
  type StepStats,
  allocateSequences,
  calcStats,
  createIssue,
  ensureProject,
  generateRanks,
  printStats,
  trackError
} from '../helpers'
import { createWorkspaces, connectToWorkspaces, type WorkspaceInfo } from '../workspace-manager'


interface WorkspaceStepResult {
  workspaceName: string
  operation: string
  stats: StepStats
}

interface MultiWorkspaceResult {
  workspaceCount: number
  clientsPerWorkspace: number
  durationSec: number
  perWorkspace: WorkspaceStepResult[]
  aggregate: StepStats
}

// Per-workspace worker

async function runWorkspaceWorker (
  wsInfo: WorkspaceInfo,
  cfg: BenchConfig,
  clientsPerWs: number,
  durationSec: number
): Promise<WorkspaceStepResult[]> {
  const results: WorkspaceStepResult[] = []

  // Create REST clients for this workspace
  const clients: RestClient[] = Array.from({ length: clientsPerWs }, () =>
    createRestClient(wsInfo.token.endpoint, wsInfo.token.workspaceId, wsInfo.token.token)
  )

  let txOps: TxOperations
  try {
    txOps = await createRestTxOperations(
      wsInfo.token.endpoint,
      wsInfo.token.workspaceId,
      wsInfo.token.token
    )
  } catch (err: any) {
    console.error(`  [${wsInfo.name}] failed to create tx client: ${err.message}`)
    return results
  }

  // Ensure employee in this workspace
  try {
    const accountCl = getAccountClient(
      wsInfo.token.endpoint.replace(/\/api\/v1.*/, '').replace(/:\d+$/, ':3000'),
      wsInfo.token.token
    )
    const person = await accountCl.getPerson()
    const socialIds = await accountCl.getSocialIds(true)
    const testCtx = new MeasureMetricsContext('bench', {})

    await ensureEmployee(
      testCtx,
      {
        uuid: wsInfo.token.info.account,
        role: wsInfo.token.info.role,
        primarySocialId: pickPrimarySocialId(socialIds)._id,
        socialIds: socialIds.map((si) => si._id),
        fullSocialIds: socialIds
      },
      clients[0],
      socialIds,
      async () => person
    )
  } catch (err: any) {
    console.log(`  [${wsInfo.name}] ensureEmployee warning: ${err.message}`)
  }

  // Ensure project
  const projId = `MW${wsInfo.name.replace(/[^a-zA-Z0-9]/g, '').slice(-3).toUpperCase()}`
  let project: Project
  try {
    project = await ensureProject(clients[0], txOps, projId, `MultiWS ${wsInfo.name}`)
  } catch (err: any) {
    console.error(`  [${wsInfo.name}] failed to ensure project: ${err.message}`)
    return results
  }

  // Pre-allocate sequences and ranks
  const totalEstimate = clientsPerWs * durationSec * 50
  let baseSeq: number
  try {
    baseSeq = await allocateSequences(clients[0], project, totalEstimate)
  } catch {
    baseSeq = (project.sequence ?? 0) + 1
  }
  const seqCounter = { val: baseSeq }
  const ranks = generateRanks(5000)
  const rankIdx = { val: 0 }

  const getSeq = (): number => seqCounter.val++
  const getRank = (): string => {
    const r = ranks[rankIdx.val % ranks.length]
    rankIdx.val++
    return r
  }

  // --- Mixed workload: reads + writes ---
  const timings: number[] = []
  const errors = new Map<string, number>()
  const endTime = Date.now() + durationSec * 1000
  const globalStart = performance.now()

  const workers = clients.map(async (client) => {
    while (Date.now() < endTime) {
      const start = performance.now()
      try {
        const roll = Math.random()
        if (roll < 0.4) {
          await client.findAll(core.class.Space, {}, { limit: 100 })
        } else if (roll < 0.7) {
          await client.findAll(tracker.class.Issue, { space: project._id }, { limit: 50 })
        } else if (roll < 0.95) {
          await createIssue(client, project, getSeq(), getRank(), `MW-${wsInfo.name}-${getSeq()}`)
        } else {
          // Update random issue
          const issues = await client.findAll(tracker.class.Issue, { space: project._id }, { limit: 10 })
          if (issues.length > 0) {
            const issue = issues[Math.floor(Math.random() * issues.length)]
            await client.update(issue, { priority: Math.floor(Math.random() * 5) } as any)
          }
        }
        timings.push(performance.now() - start)
      } catch (err: any) {
        trackError(errors, err)
      }
    }
  })

  await Promise.allSettled(workers)
  const wallMs = performance.now() - globalStart

  const stats = calcStats(`${wsInfo.name}(${clientsPerWs} clients)`, timings, wallMs, errors)
  results.push({ workspaceName: wsInfo.name, operation: 'mixed-rw', stats })

  return results
}

// Public entry point

export async function runMultiWorkspace (cfg: BenchConfig): Promise<MultiWorkspaceResult> {
  const wsCount = cfg.workspaces
  const clientsPerWs = cfg.clients[0] ?? 5
  const durationSec = cfg.duration

  console.log(`\n========================================`)
  console.log(`  SCENARIO: Multi-Workspace Stress`)
  console.log(`  workspaces: ${wsCount}`)
  console.log(`  clients/ws: ${clientsPerWs}`)
  console.log(`  total clients: ${wsCount * clientsPerWs}`)
  console.log(`  duration: ${durationSec}s`)
  console.log(`========================================\n`)

  const config = await loadServerConfig(cfg.url)

  // Create or connect to workspaces
  let workspaces: WorkspaceInfo[]
  if (cfg.workspaceList !== undefined && cfg.workspaceList.length > 0) {
    console.log(`  connecting to ${cfg.workspaceList.length} existing workspaces...`)
    workspaces = await connectToWorkspaces(cfg, config, cfg.workspaceList)
  } else {
    console.log(`  creating ${wsCount} workspaces...`)
    workspaces = await createWorkspaces(cfg, config, wsCount, cfg.region)
  }

  if (workspaces.length === 0) {
    throw new Error('No workspaces available for testing')
  }

  console.log(`\n  starting stress test across ${workspaces.length} workspaces...`)

  // Run all workspace workers concurrently
  const allResults = await Promise.all(
    workspaces.map(async (ws) => await runWorkspaceWorker(ws, cfg, clientsPerWs, durationSec))
  )

  const perWorkspace = allResults.flat()

  // Aggregate stats
  const allTimings: number[] = []
  const allErrors = new Map<string, number>()
  let totalWallMs = 0

  for (const r of perWorkspace) {
    totalWallMs = Math.max(totalWallMs, r.stats.wallMs)
    // We don't have raw timings, but we can approximate from stats
  }

  // Print per-workspace results
  console.log(`\n========================================`)
  console.log(`  RESULTS: Multi-Workspace Stress`)
  console.log(`========================================`)
  console.log(
    `${'workspace'.padEnd(25)} ${'ops/s'.padStart(8)} ${'avg'.padStart(8)} ` +
    `${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)} ${'errs'.padStart(6)}`
  )
  console.log('-'.repeat(75))

  let totalOps = 0
  let totalFailed = 0

  for (const r of perWorkspace) {
    totalOps += r.stats.realOpsPerSec
    totalFailed += r.stats.failed
    console.log(
      `${r.workspaceName.padEnd(25)} ` +
      `${String(r.stats.realOpsPerSec).padStart(8)} ` +
      `${(r.stats.avgMs + 'ms').padStart(8)} ` +
      `${(r.stats.p95Ms + 'ms').padStart(8)} ` +
      `${(r.stats.p99Ms + 'ms').padStart(8)} ` +
      `${(r.stats.maxMs + 'ms').padStart(8)} ` +
      `${String(r.stats.failed).padStart(6)}`
    )
  }

  console.log('-'.repeat(75))
  console.log(`  total ops/s: ${totalOps}  total errors: ${totalFailed}`)

  // Build aggregate
  const aggregate = calcStats(
    `multi-ws(${workspaces.length}ws x ${clientsPerWs}cl)`,
    [], // no raw timings available
    totalWallMs,
    allErrors
  )
  aggregate.realOpsPerSec = totalOps

  return {
    workspaceCount: workspaces.length,
    clientsPerWorkspace: clientsPerWs,
    durationSec,
    perWorkspace,
    aggregate
  }
}
