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

import core, { generateId, type Ref } from '@hcengineering/core'
import type { RestClient } from '@hcengineering/api-client'
import tracker, { type Issue, type Project } from '@hcengineering/tracker'

import type { BenchConfig } from '../config'
import {
  type ConnectionPool,
  type StepStats,
  allocateSequences,
  calcStats,
  createIssue,
  ensureProject,
  generateRanks,
  makeRestClient,
  makeRestClients,
  makeTxClient,
  printStats,
  trackError
} from '../helpers'

type Operation = 'findAll-spaces' | 'findAll-issues' | 'create-issue' | 'update-issue' | 'mixed-rw'

interface StepResult {
  clientCount: number
  operation: Operation
  stats: StepStats
}

// Individual operations

async function opFindAllSpaces (client: RestClient): Promise<void> {
  await client.findAll(core.class.Space, {}, { limit: 100 })
}

async function opFindAllIssues (client: RestClient, project: Project): Promise<void> {
  await client.findAll(tracker.class.Issue, { space: project._id }, { limit: 50 })
}

async function opCreateIssue (
  client: RestClient,
  project: Project,
  getSeq: () => number,
  getRank: () => string
): Promise<void> {
  const seq = getSeq()
  const rank = getRank()
  await createIssue(client, project, seq, rank, `Throughput #${seq}`)
}

async function opUpdateIssue (client: RestClient, issueIds: Array<Ref<Issue>>): Promise<void> {
  if (issueIds.length === 0) return
  const randomId = issueIds[Math.floor(Math.random() * issueIds.length)]
  const issue = await client.findOne(tracker.class.Issue, { _id: randomId })
  if (issue !== undefined) {
    await client.update(issue, { priority: Math.floor(Math.random() * 5) } as any)
  }
}

// Run one step: N clients, one operation, fixed duration

async function runStep (
  clients: RestClient[],
  operation: Operation,
  durationSec: number,
  project: Project,
  seqCounter: { val: number },
  ranks: string[],
  rankIdx: { val: number },
  issueIds: Array<Ref<Issue>>
): Promise<StepStats> {
  const timings: number[] = []
  const errors = new Map<string, number>()
  const endTime = Date.now() + durationSec * 1000

  const getSeq = (): number => seqCounter.val++
  const getRank = (): string => {
    const r = ranks[rankIdx.val % ranks.length]
    rankIdx.val++
    return r
  }

  const globalStart = performance.now()

  const workers = clients.map(async (client) => {
    while (Date.now() < endTime) {
      const start = performance.now()
      try {
        switch (operation) {
          case 'findAll-spaces':
            await opFindAllSpaces(client)
            break
          case 'findAll-issues':
            await opFindAllIssues(client, project)
            break
          case 'create-issue':
            await opCreateIssue(client, project, getSeq, getRank)
            break
          case 'update-issue':
            await opUpdateIssue(client, issueIds)
            break
          case 'mixed-rw': {
            const roll = Math.random()
            if (roll < 0.4) {
              await opFindAllSpaces(client)
            } else if (roll < 0.8) {
              await opFindAllIssues(client, project)
            } else if (roll < 0.95) {
              await opCreateIssue(client, project, getSeq, getRank)
            } else {
              await opUpdateIssue(client, issueIds)
            }
            break
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

  return calcStats(`${operation}(${clients.length} clients)`, timings, wallMs, errors)
}

// Public entry point

export async function runRestThroughput (cfg: BenchConfig, pool: ConnectionPool): Promise<StepResult[]> {
  console.log(`\n========================================`)
  console.log(`  SCENARIO: REST Throughput`)
  console.log(`  client steps: ${cfg.clients.join(', ')}`)
  console.log(`  duration per step: ${cfg.duration}s`)
  console.log(`========================================\n`)

  const conn = makeRestClient(pool.wsToken)
  const txOps = await makeTxClient(pool.wsToken)

  // Ensure a project for the test
  const project = await ensureProject(conn, txOps, 'RTHR', 'REST Throughput')
  console.log(`  project: ${project.identifier} (${project._id})`)

  // Pre-allocate large sequence block
  const totalEstimate = cfg.clients[cfg.clients.length - 1] * cfg.duration * 100
  const baseSeq = await allocateSequences(conn, project, totalEstimate)
  const seqCounter = { val: baseSeq }

  // Pre-generate ranks
  const ranks = generateRanks(10000)
  const rankIdx = { val: 0 }

  // Seed some issues for update operations
  console.log(`  seeding 100 issues for update tests...`)
  const issueIds: Array<Ref<Issue>> = []
  for (let i = 0; i < 100; i++) {
    const seq = seqCounter.val++
    const id = await createIssue(conn, project, seq, ranks[i % ranks.length], `Seed #${i}`)
    issueIds.push(id)
  }
  console.log(`  seeded ${issueIds.length} issues`)

  const operations: Operation[] = ['findAll-spaces', 'findAll-issues', 'create-issue', 'update-issue', 'mixed-rw']
  const results: StepResult[] = []

  for (const operation of operations) {
    console.log(`\n--- ${operation} ---`)

    for (const clientCount of cfg.clients) {
      const clients = makeRestClients(pool.wsToken, clientCount)

      const stats = await runStep(
        clients,
        operation,
        cfg.duration,
        project,
        seqCounter,
        ranks,
        rankIdx,
        issueIds
      )

      printStats(stats)
      results.push({ clientCount, operation, stats })
    }
  }

  // Summary table
  console.log(`\n========================================`)
  console.log(`  SUMMARY: REST Throughput`)
  console.log(`========================================`)
  console.log(`${'operation'.padEnd(20)} ${'clients'.padStart(8)} ${'ops/s'.padStart(8)} ${'avg'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)} ${'errs'.padStart(6)}`)
  console.log('-'.repeat(78))
  for (const r of results) {
    console.log(
      `${r.operation.padEnd(20)} ${String(r.clientCount).padStart(8)} ` +
        `${String(r.stats.realOpsPerSec).padStart(8)} ` +
        `${(r.stats.avgMs + 'ms').padStart(8)} ` +
        `${(r.stats.p95Ms + 'ms').padStart(8)} ` +
        `${(r.stats.p99Ms + 'ms').padStart(8)} ` +
        `${(r.stats.maxMs + 'ms').padStart(8)} ` +
        `${String(r.stats.failed).padStart(6)}`
    )
  }

  return results
}
