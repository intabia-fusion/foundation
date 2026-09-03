//
// Copyright © 2026 Intabia Fusion
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

/* eslint-disable @typescript-eslint/unbound-method, no-console */
import core, {
  generateId,
  MeasureMetricsContext,
  TxOperations,
  type Doc,
  type MeasureContext,
  type PersonUuid,
  type Ref,
  type Tx,
  type WorkspaceDataId,
  type WorkspaceInfoWithStatus,
  type WorkspaceUuid
} from '@hcengineering/core'
import { WorkspaceManager } from '../manager'

import { createPlatformQueue, parseQueueConfig } from '@hcengineering/kafka'
import {
  createDummyStorageAdapter,
  QueueTopic,
  type FulltextListener,
  type IndexedDoc
} from '@hcengineering/server-core'
import { decodeToken, generateToken } from '@hcengineering/server-token'
import { randomUUID } from 'crypto'
import { createDoc, test, type TestDocument } from './minmodel'

import { dbConfig, dbUrl, elasticIndexName, kafkaBroker, model, prepare, preparePipeline } from './utils'

prepare()
jest.mock('franc-min', () => ({ franc: () => 'en' }), { virtual: true })

jest.setTimeout(600_000)

interface BenchResult {
  scenario: string
  docs: number
  sendMs: number
  indexMs: number
  totalMs: number
  sendDocsPerSec: number
  indexDocsPerSec: number
  totalDocsPerSec: number
}

const results: BenchResult[] = []

function record (r: BenchResult): void {
  results.push(r)
  console.log(
    `[bench] ${r.scenario}: docs=${r.docs} send=${r.sendMs}ms index=${r.indexMs}ms total=${r.totalMs}ms throughput=${r.totalDocsPerSec.toFixed(1)} docs/s`
  )
}

class BenchHarness {
  genId = generateId()
  config = parseQueueConfig(`${kafkaBroker};-bench-` + this.genId, 'fulltext-bench-' + this.genId, '')
  queue = createPlatformQueue(this.config)
  mgr!: BenchWorkspaceManager
  fulltextListener: FulltextListener | undefined

  constructor (readonly ctx: MeasureContext) {}

  async start (): Promise<void> {
    await this.queue.createTopics(1)
    this.mgr = new BenchWorkspaceManager(this.ctx, model, {
      queue: this.queue,
      accountsUrl: 'http://localhost:3003',
      elasticIndexName,
      serverSecret: 'secret',
      dbURL: dbUrl,
      hulylakeUrl: 'http://localhost:8096',
      config: dbConfig,
      externalStorage: createDummyStorageAdapter(),
      listener: {
        onIndexing: async (doc: IndexedDoc) => {
          return await this.fulltextListener?.onIndexing?.(doc)
        },
        onClean: async (doc: Ref<Doc>[]) => {
          return await this.fulltextListener?.onClean?.(doc)
        }
      }
    })
    await this.mgr.startIndexer()
    await this.mgr.waitConsumersReady()
  }

  async close (): Promise<void> {
    await this.mgr.shutdown(true)
    // Each harness creates its own postfixed topics. Redpanda in tests caps total partitions, so
    // leftovers from previous runs eventually block topic creation and starve the consumer.
    await this.queue.deleteTopics()
    await this.queue.shutdown()
  }

  // Resolves when expected number of indexed docs matching predicate are observed.
  awaitIndexed (count: number, marker: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let seen = 0
      const startedAt = Date.now()
      const to = setTimeout(() => {
        reject(new Error(`bench timeout: indexed ${seen}/${count} for marker=${marker}`))
      }, 580_000)
      to.unref?.()
      this.fulltextListener = {
        onIndexing: async (doc) => {
          if ((doc.fulltextSummary ?? '').includes(marker)) {
            seen++
            if (seen >= count) {
              clearTimeout(to)
              resolve(Date.now() - startedAt)
            }
          }
        }
      }
    })
  }
}

class BenchWorkspaceManager extends WorkspaceManager {
  public async getWorkspaceInfo (ctx: MeasureContext, token?: string): Promise<WorkspaceInfoWithStatus | undefined> {
    const decodedToken = decodeToken(token ?? '')
    return {
      uuid: decodedToken.workspace,
      url: decodedToken.workspace,
      region: 'test',
      name: 'bench',
      dataId: decodedToken.workspace as unknown as WorkspaceDataId,
      mode: 'active',
      processingProgress: 0,
      processingAttemps: 0,
      backupInfo: { dataSize: 0, blobsSize: 0, backupSize: 0, lastBackup: 0, backups: 0 },
      versionMajor: 0,
      versionMinor: 6,
      versionPatch: 0,
      lastVisit: 0,
      createdOn: 0,
      createdBy: decodedToken.account
    }
  }

  async getTransactorAPIEndpoint (token: string): Promise<string | undefined> {
    return undefined
  }
}

describe('fulltext-indexing-bench', () => {
  const toolCtx = new MeasureMetricsContext('bench', {})

  afterAll(() => {
    console.log('\n[bench] summary')
    console.table(
      results.map((r) => ({
        scenario: r.scenario,
        docs: r.docs,
        'send(ms)': r.sendMs,
        'index(ms)': r.indexMs,
        'total(ms)': r.totalMs,
        'send/s': r.sendDocsPerSec.toFixed(1),
        'index/s': r.indexDocsPerSec.toFixed(1),
        'total/s': r.totalDocsPerSec.toFixed(1)
      }))
    )
  })

  async function runProducerBulk (docs: number, batchSize: number, label: string): Promise<void> {
    const h = new BenchHarness(toolCtx)
    await h.start()
    try {
      const txProducer = h.queue.getProducer<Tx>(toolCtx, QueueTopic.Tx)
      const personId = randomUUID().toString() as PersonUuid
      const wsId: WorkspaceUuid = randomUUID().toString() as WorkspaceUuid
      const token = generateToken(personId, wsId)
      await h.mgr.withIndexer(toolCtx, wsId, token, true, async () => {})

      const marker = 'bench-' + generateId()
      const allTxs: Tx[] = []
      for (let i = 0; i < docs; i++) {
        allTxs.push(
          createDoc(test.class.TestDocument, {
            title: `doc-${i}`,
            description: `${marker}-${i}`
          })
        )
      }

      const indexedDone = h.awaitIndexed(docs, marker)
      const t0 = Date.now()
      for (let i = 0; i < allTxs.length; i += batchSize) {
        const slice = allTxs.slice(i, i + batchSize)
        await txProducer.send(toolCtx, wsId, slice)
      }
      const sendMs = Date.now() - t0
      const indexMs = await indexedDone
      const totalMs = Date.now() - t0

      record({
        scenario: label,
        docs,
        sendMs,
        indexMs,
        totalMs,
        sendDocsPerSec: (docs * 1000) / Math.max(sendMs, 1),
        indexDocsPerSec: (docs * 1000) / Math.max(indexMs, 1),
        totalDocsPerSec: (docs * 1000) / Math.max(totalMs, 1)
      })
    } finally {
      // close harness keeps queue.queue used by txProducer; close handles it
      await h.close()
    }
  }

  // BulkA: 200 docs, send one-by-one (batch=1) - exercises producer single send
  it('producer-bulk: 200 docs, batch=1', async () => {
    await runProducerBulk(200, 1, 'producer batch=1, 200 docs')
  })

  // BulkB: 200 docs, send as 4x50 batches
  it('producer-bulk: 200 docs, batch=50', async () => {
    await runProducerBulk(200, 50, 'producer batch=50, 200 docs')
  })

  // BulkC: 1000 docs as one bulk send
  it('producer-bulk: 1000 docs, batch=1000', async () => {
    await runProducerBulk(1000, 1000, 'producer batch=1000, 1000 docs')
  })

  // E2E via pipeline: createDoc x N
  it('pipeline e2e: 200 createDoc', async () => {
    const h = new BenchHarness(toolCtx)
    await h.start()
    const { pipeline, wsIds } = await preparePipeline(toolCtx, h.queue)
    try {
      const { wrapPipeline } = await import('@hcengineering/server-core')
      const pipelineClient = wrapPipeline(toolCtx, pipeline, wsIds, true)
      const ops = new TxOperations(pipelineClient, core.account.System)

      const marker = 'bench-' + generateId()
      const docs = 200

      const indexedDone = h.awaitIndexed(docs, marker)
      const t0 = Date.now()
      const ids: Ref<TestDocument>[] = []
      for (let i = 0; i < docs; i++) {
        const id = await ops.createDoc(test.class.TestDocument, core.space.Workspace, {
          title: `e2e-${i}`,
          description: `${marker}-${i}`
        })
        ids.push(id)
      }
      const sendMs = Date.now() - t0
      const indexMs = await indexedDone
      const totalMs = Date.now() - t0

      record({
        scenario: 'pipeline e2e, 200 createDoc',
        docs,
        sendMs,
        indexMs,
        totalMs,
        sendDocsPerSec: (docs * 1000) / Math.max(sendMs, 1),
        indexDocsPerSec: (docs * 1000) / Math.max(indexMs, 1),
        totalDocsPerSec: (docs * 1000) / Math.max(totalMs, 1)
      })
    } finally {
      await h.close()
      await pipeline.close()
    }
  })
})
