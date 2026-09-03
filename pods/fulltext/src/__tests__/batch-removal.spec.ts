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

/* eslint-disable @typescript-eslint/unbound-method */
import core, {
  generateId,
  MeasureMetricsContext,
  TxFactory,
  type Doc,
  type MeasureContext,
  type PersonUuid,
  type Ref,
  type Tx,
  type TxCUD,
  type WorkspaceDataId,
  type WorkspaceInfoWithStatus,
  type WorkspaceUuid
} from '@hcengineering/core'
import { WorkspaceManager } from '../manager'

import { createPlatformQueue, parseQueueConfig } from '@hcengineering/kafka'
import { createDummyStorageAdapter, QueueTopic, type IndexedDoc } from '@hcengineering/server-core'
import { decodeToken, generateToken } from '@hcengineering/server-token'
import { randomUUID } from 'crypto'
import { createDoc, test, type TestDocument } from './minmodel'

import { dbConfig, dbUrl, elasticIndexName, kafkaBroker, model, prepare } from './utils'

prepare()
jest.mock('franc-min', () => ({ franc: () => 'en' }), { virtual: true })

jest.setTimeout(60000)

class TestWorkspaceManager extends WorkspaceManager {
  public async getWorkspaceInfo (ctx: MeasureContext, token?: string): Promise<WorkspaceInfoWithStatus | undefined> {
    const decodedToken = decodeToken(token ?? '')
    return {
      uuid: decodedToken.workspace,
      url: decodedToken.workspace,
      region: 'test',
      name: 'batch-removal-test',
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

class Harness {
  genId = generateId()
  config = parseQueueConfig(`${kafkaBroker};-batch-rm-` + this.genId, 'fulltext-batch-rm-' + this.genId, '')
  queue = createPlatformQueue(this.config)
  mgr!: TestWorkspaceManager
  indexed = new Map<string, IndexedDoc>() // by _id
  cleaned = new Set<string>()

  constructor (readonly ctx: MeasureContext) {}

  async start (): Promise<void> {
    await this.queue.createTopics(1)
    this.mgr = new TestWorkspaceManager(this.ctx, model, {
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
          this.indexed.set(String(doc.id), doc)
        },
        onClean: async (ids: Ref<Doc>[]) => {
          for (const id of ids) this.cleaned.add(String(id))
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

  async waitFor (predicate: () => boolean, timeoutMs = 20000, label = 'condition'): Promise<void> {
    const t0 = Date.now()
    while (!predicate()) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `Timeout (${timeoutMs}ms) waiting for ${label}. indexed=[${[...this.indexed.keys()].join(',')}] cleaned=[${[...this.cleaned].join(',')}]`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

describe('fulltext batch-removal scenarios', () => {
  const toolCtx = new MeasureMetricsContext('batch-rm', {})
  const txFactory = new TxFactory(core.account.System)

  async function setup (): Promise<{ h: Harness, wsId: WorkspaceUuid, txProducer: any }> {
    const h = new Harness(toolCtx)
    await h.start()
    const personId = randomUUID().toString() as PersonUuid
    const wsId: WorkspaceUuid = randomUUID().toString() as WorkspaceUuid
    const token = generateToken(personId, wsId)
    await h.mgr.withIndexer(toolCtx, wsId, token, true, async () => {})
    const txProducer = h.queue.getProducer<Tx>(toolCtx, QueueTopic.Tx)
    return { h, wsId, txProducer }
  }

  function removeTx<T extends Doc> (_class: Ref<any>, space: Ref<any>, objectId: Ref<T>): TxCUD<Doc> {
    return txFactory.createTxRemoveDoc(_class, space, objectId) as any as TxCUD<Doc>
  }

  it('A: create + remove in the SAME batch -> not indexed, cleaned', async () => {
    const { h, wsId, txProducer } = await setup()
    try {
      const create = createDoc(test.class.TestDocument, {
        title: 'doc-A',
        description: 'sceneA-' + generateId()
      })
      const remove = removeTx(test.class.TestDocument, core.space.Workspace, create.objectId as Ref<TestDocument>)

      await txProducer.send(toolCtx, wsId, [create, remove])

      // Wait a bit for processing to settle
      await new Promise((resolve) => setTimeout(resolve, 5000))

      // Doc should NOT be in indexed (remove wins in buildDoc2Doc -> null -> toRemove)
      const id = String(create.objectId)
      expect(h.indexed.has(id)).toBe(false)
      expect(h.cleaned.has(id)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('B: create then remove in SEPARATE batches -> indexed first, then cleaned', async () => {
    const { h, wsId, txProducer } = await setup()
    try {
      const create = createDoc(test.class.TestDocument, {
        title: 'doc-B',
        description: 'sceneB-' + generateId()
      })
      await txProducer.send(toolCtx, wsId, [create])

      const id = String(create.objectId)
      await h.waitFor(() => h.indexed.has(id), 20000, `indexed ${id}`)

      const remove = removeTx(test.class.TestDocument, core.space.Workspace, create.objectId as Ref<TestDocument>)
      await txProducer.send(toolCtx, wsId, [remove])

      await h.waitFor(() => h.cleaned.has(id), 20000, `cleaned ${id}`)
      expect(h.cleaned.has(id)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('C: create + many updates + remove all in one batch -> cleaned, not indexed', async () => {
    const { h, wsId, txProducer } = await setup()
    try {
      const create = createDoc(test.class.TestDocument, {
        title: 'doc-C',
        description: 'sceneC-' + generateId()
      })
      const txs: TxCUD<Doc>[] = [create as any as TxCUD<Doc>]
      for (let i = 0; i < 10; i++) {
        txs.push(
          txFactory.createTxUpdateDoc<TestDocument>(
            test.class.TestDocument as Ref<any>,
            core.space.Workspace,
            create.objectId as Ref<TestDocument>,
            {
              title: `doc-C-upd-${i}`
            }
          ) as any as TxCUD<Doc>
        )
      }
      txs.push(removeTx(test.class.TestDocument, core.space.Workspace, create.objectId as Ref<TestDocument>))

      await txProducer.send(toolCtx, wsId, txs)

      await new Promise((resolve) => setTimeout(resolve, 5000))

      const id = String(create.objectId)
      expect(h.indexed.has(id)).toBe(false)
      expect(h.cleaned.has(id)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('D: remove arrives in batch WITHOUT create (create was earlier) -> cleaned', async () => {
    // This is the "split across batches" scenario that I was worried about.
    // Create is in batch 1, remove is in batch 2.
    const { h, wsId, txProducer } = await setup()
    try {
      const create = createDoc(test.class.TestDocument, {
        title: 'doc-D',
        description: 'sceneD-' + generateId()
      })
      await txProducer.send(toolCtx, wsId, [create])

      const id = String(create.objectId)
      await h.waitFor(() => h.indexed.has(id), 20000, `indexed ${id}`)

      // Now send remove alone (or with unrelated noise) in a separate batch
      const noise = createDoc(test.class.TestDocument, {
        title: 'noise',
        description: 'noise-' + generateId()
      })
      const remove = removeTx(test.class.TestDocument, core.space.Workspace, create.objectId as Ref<TestDocument>)
      await txProducer.send(toolCtx, wsId, [noise, remove])

      await h.waitFor(() => h.cleaned.has(id), 20000, `cleaned ${id}`)
      expect(h.cleaned.has(id)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('E: update arrives AFTER remove in a separate batch -> doc stays cleaned (no resurrection)', async () => {
    // Concern: trigger fires update-tx after document is already removed.
    // The update arrives in a later batch, doc is not in storage anymore.
    // loadDocsFromTx: buildDoc2Doc([update]) -> undefined -> docsToRetrieve.
    // storage.findAll returns nothing for deleted doc -> doc silently NOT indexed.
    // This is correct behavior - the doc stays removed.
    const { h, wsId, txProducer } = await setup()
    try {
      const create = createDoc(test.class.TestDocument, {
        title: 'doc-E',
        description: 'sceneE-' + generateId()
      })
      const remove = removeTx(test.class.TestDocument, core.space.Workspace, create.objectId as Ref<TestDocument>)

      await txProducer.send(toolCtx, wsId, [create, remove])
      await new Promise((resolve) => setTimeout(resolve, 3000))

      const id = String(create.objectId)
      expect(h.cleaned.has(id)).toBe(true)
      h.indexed.delete(id) // reset for the next check

      // Now send a stray update after the doc is already removed
      const update = txFactory.createTxUpdateDoc<TestDocument>(
        test.class.TestDocument as Ref<any>,
        core.space.Workspace,
        create.objectId as Ref<TestDocument>,
        {
          title: 'doc-E-stray-update'
        }
      )
      await txProducer.send(toolCtx, wsId, [update])

      // Give it time to process
      await new Promise((resolve) => setTimeout(resolve, 3000))

      // Doc must NOT reappear in the index
      expect(h.indexed.has(id)).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('F: large batch with mixed create/update/remove for many docs', async () => {
    const { h, wsId, txProducer } = await setup()
    try {
      const N = 50
      const creates = []
      const removes = []
      for (let i = 0; i < N; i++) {
        const c = createDoc(test.class.TestDocument, {
          title: `doc-F-${i}`,
          description: 'sceneF-' + generateId()
        })
        creates.push(c)
        if (i % 3 === 0) {
          // every third doc is created+removed in same batch
          removes.push(removeTx(test.class.TestDocument, core.space.Workspace, c.objectId as Ref<TestDocument>))
        }
      }

      await txProducer.send(toolCtx, wsId, [...creates, ...removes] as Tx[])

      await new Promise((resolve) => setTimeout(resolve, 10000))

      let expectedIndexed = 0
      let expectedCleaned = 0
      for (let i = 0; i < N; i++) {
        const id = String(creates[i].objectId)
        if (i % 3 === 0) {
          expect(h.indexed.has(id)).toBe(false)
          expect(h.cleaned.has(id)).toBe(true)
          expectedCleaned++
        } else {
          expect(h.indexed.has(id)).toBe(true)
          expectedIndexed++
        }
      }
      // sanity
      expect(expectedIndexed + expectedCleaned).toBe(N)
    } finally {
      await h.close()
    }
  })

  it('G: many workspaces in parallel (mimics CI sanity with multiple test workspaces)', async () => {
    // Reproduces CI scenario where multiple workspaces send tx concurrently.
    // With Tx topic = 10 partitions and partitionKey = workspace,
    // each workspace lands on its own partition.
    // kafkajs default partitionsConsumedConcurrently = 1 means SDK serializes
    // partition processing. This test should reveal if batch consumer's
    // per-partition latency causes timeouts under multi-workspace load.
    const h = new Harness(toolCtx)
    await h.start()
    try {
      const txProducer = h.queue.getProducer<Tx>(toolCtx, QueueTopic.Tx)
      const personId = randomUUID().toString() as PersonUuid
      const WS_COUNT = 10 // matches partition count
      const wsList: WorkspaceUuid[] = []
      for (let i = 0; i < WS_COUNT; i++) {
        const wsId = randomUUID().toString() as WorkspaceUuid
        wsList.push(wsId)
        const token = generateToken(personId, wsId)
        await h.mgr.withIndexer(toolCtx, wsId, token, true, async () => {})
      }

      // For each ws: send a large batch (create N docs) + later send remove for half of them
      const N = 20
      const allCreates: Array<{ wsId: WorkspaceUuid, id: Ref<TestDocument>, removed: boolean }> = []

      // Phase 1: all workspaces send creates in parallel
      const phase1 = wsList.map(async (wsId, wsIdx) => {
        const txs: Tx[] = []
        for (let i = 0; i < N; i++) {
          const c = createDoc(test.class.TestDocument, {
            title: `doc-G-ws${wsIdx}-${i}`,
            description: `sceneG-${wsIdx}-${i}-` + generateId()
          })
          txs.push(c)
          allCreates.push({ wsId, id: c.objectId as Ref<TestDocument>, removed: i % 2 === 0 })
        }
        await txProducer.send(toolCtx, wsId, txs)
      })
      await Promise.all(phase1)

      // Wait until all docs are indexed
      await h.waitFor(
        () => allCreates.every((d) => h.indexed.has(String(d.id))),
        45000,
        `${allCreates.length} docs indexed`
      )

      // Phase 2: send removes for half of them, again in parallel
      const phase2 = wsList.map(async (wsId) => {
        const removes = allCreates
          .filter((d) => d.wsId === wsId && d.removed)
          .map((d) => removeTx(test.class.TestDocument, core.space.Workspace, d.id))
        if (removes.length > 0) {
          await txProducer.send(toolCtx, wsId, removes as Tx[])
        }
      })
      await Promise.all(phase2)

      // Wait until all removes are processed
      const toBeCleaned = allCreates.filter((d) => d.removed).map((d) => String(d.id))
      await h.waitFor(
        () => toBeCleaned.every((id) => h.cleaned.has(id)),
        45000,
        `${toBeCleaned.length} docs cleaned across ${WS_COUNT} workspaces`
      )

      for (const d of allCreates) {
        if (d.removed) {
          expect(h.cleaned.has(String(d.id))).toBe(true)
        } else {
          expect(h.indexed.has(String(d.id))).toBe(true)
        }
      }
    } finally {
      await h.close()
    }
  })
})
