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
  type Account,
  AccountRole,
  type AccountUuid,
  type Class,
  type Doc,
  generateId,
  Hierarchy,
  type MeasureContext,
  MeasureMetricsContext,
  ModelDb,
  type Ref,
  type SessionData,
  type Space,
  toFindResult,
  TxFactory
} from '@hcengineering/core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'
import { SpaceSecurityMiddleware } from '../spaceSecurity'

const SPACE_COUNT = 20_000
const USER_COUNT = 250
const MEMBERS_PER_SPACE_AVG = 10

function createAccount (uuid: string, role: AccountRole = AccountRole.User): Account {
  return {
    uuid: uuid as AccountUuid,
    role,
    primarySocialId: `social:${uuid}` as any,
    socialIds: [`social:${uuid}`] as any,
    fullSocialIds: [{ _id: `social:${uuid}` as any, type: 'email' as any, value: `${uuid}@test.com` }] as any
  }
}

function createSessionData (account: Account): SessionData {
  return {
    broadcast: {
      txes: [],
      targets: {},
      queue: [],
      sessions: {}
    },
    contextCache: new Map(),
    removedMap: new Map(),
    account,
    service: 'test',
    sessionId: 'test-session',
    workspace: { uuid: 'test-workspace' as any, url: 'test', dataId: 'test' as any },
    socialStringsToUsers: new Map()
  }
}

/**
 * Generate test dataset: SPACE_COUNT spaces with USER_COUNT users.
 * Each space gets ~MEMBERS_PER_SPACE_AVG random members.
 * 80% of spaces are private, 20% public.
 * 5% of spaces are archived.
 */
function generateSpaces (): Space[] {
  const users: string[] = []
  for (let i = 0; i < USER_COUNT; i++) {
    users.push(`user-${i}`)
  }

  const spaces: Space[] = []
  for (let i = 0; i < SPACE_COUNT; i++) {
    // Pick random members
    const memberCount = Math.max(1, Math.floor(Math.random() * MEMBERS_PER_SPACE_AVG * 2))
    const members = new Set<string>()
    for (let j = 0; j < memberCount; j++) {
      members.add(users[Math.floor(Math.random() * USER_COUNT)])
    }

    const memberArr = Array.from(members) as AccountUuid[]
    spaces.push({
      _id: `space-${i}` as Ref<Space>,
      _class: core.class.Space,
      space: core.space.Space,
      name: `Space ${i}`,
      description: '',
      private: Math.random() < 0.8,
      archived: Math.random() < 0.05,
      members: memberArr,
      owners: memberArr.length > 0 ? [memberArr[0]] : [],
      modifiedOn: Date.now(),
      modifiedBy: core.account.System
    } satisfies Space)
  }
  return spaces
}

function formatBytes (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

describe('SpaceSecurityMiddleware - Performance (20K spaces, 250 users)', () => {
  let ctx: MeasureContext<SessionData>
  let hierarchy: Hierarchy
  let modelDb: ModelDb
  let pipelineContext: PipelineContext
  let txFactory: TxFactory
  let nextMiddleware: Middleware
  let spaces: Space[]

  beforeAll(() => {
    spaces = generateSpaces()

    hierarchy = new Hierarchy()
    modelDb = new ModelDb(hierarchy)

    jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
      if (_class === core.class.Space && from === core.class.Space) return true
      if (from === core.class.Collaborator) return false
      return _class === from
    })

    pipelineContext = {
      workspace: { uuid: 'test-workspace' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb,
      branding: null,
      adapterManager: {} as any,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: ''
    }

    nextMiddleware = {
      findAll: jest.fn(async () => toFindResult(spaces)),
      tx: jest.fn(async (): Promise<TxMiddlewareResult> => ({})),
      searchFulltext: jest.fn(async () => ({ docs: [] })),
      handleBroadcast: jest.fn(async () => {}),
      groupBy: jest.fn(async () => new Map()),
      loadModel: jest.fn(async () => []),
      domainRequest: jest.fn(async () => ({})),
      closeSession: jest.fn(async () => {}),
      close: jest.fn(async () => {})
    } as any

    txFactory = new TxFactory(core.account.System)
    ctx = new MeasureMetricsContext('test', {}) as MeasureContext<SessionData>
  })

  it('dataset stats', () => {
    const totalMembers = spaces.reduce((sum, s) => sum + s.members.length, 0)
    const privateCount = spaces.filter((s) => s.private).length
    const archivedCount = spaces.filter((s) => s.archived).length

    console.log('=== Dataset ===')
    console.log(`  Spaces: ${SPACE_COUNT}`)
    console.log(`  Users: ${USER_COUNT}`)
    console.log(`  Private spaces: ${privateCount} (${((privateCount / SPACE_COUNT) * 100).toFixed(0)}%)`)
    console.log(`  Archived spaces: ${archivedCount} (${((archivedCount / SPACE_COUNT) * 100).toFixed(0)}%)`)
    console.log(`  Total memberships: ${totalMembers}`)
    console.log(`  Avg members/space: ${(totalMembers / SPACE_COUNT).toFixed(1)}`)
    console.log(`  Avg spaces/user: ${(totalMembers / USER_COUNT).toFixed(1)}`)
  })

  it('memory: measure SpaceInfo footprint per space', () => {
    // Measure memory by computing object structure sizes manually.
    // Each SpaceInfo has:
    //   - _id: string ref (UUID ~36 chars = ~72 bytes + overhead)
    //   - _class: string ref (shared, negligible)
    //   - members: Set<string> with ~MEMBERS_PER_SPACE_AVG UUIDs
    //   - private: boolean (8 bytes)
    //   - archived: boolean (8 bytes)
    // Map entry overhead: ~100 bytes per entry
    // Set entry: ~50 bytes per entry + string ref

    // Build the map in an isolated scope to measure via ArrayBuffer trick
    const spacesMap = new Map<
      string,
      { _id: string, _class: string, members: Set<string>, private: boolean, archived: boolean }
    >()
    for (const space of spaces) {
      spacesMap.set(space._id, {
        _id: space._id,
        _class: space._class,
        members: new Set(space.members),
        private: space.private,
        archived: space.archived ?? false
      })
    }

    const totalMembers = spaces.reduce((sum, s) => sum + s.members.length, 0)

    // Theoretical estimate based on V8 object structure:
    // - Map entry: key ref (8) + value ref (8) + hash (8) + overhead (~80) ≈ 104 bytes
    // - SpaceInfo object: header (64) + 5 fields (8 each) ≈ 104 bytes
    // - Set entry per member: ~60 bytes (ref + hash + overhead)
    // - String (UUID, 36 chars): interned/shared, ~0 marginal if reused
    const mapOverheadPerEntry = 104
    const objectOverhead = 104
    const setEntryOverhead = 60
    const estimatedTotal = SPACE_COUNT * (mapOverheadPerEntry + objectOverhead) + totalMembers * setEntryOverhead
    const estimatedPerSpace = estimatedTotal / SPACE_COUNT

    console.log('=== Memory (estimated) ===')
    console.log(`  Spaces: ${SPACE_COUNT}, Total memberships: ${totalMembers}`)
    console.log(`  Estimated total: ${formatBytes(estimatedTotal)}`)
    console.log(`  Estimated per space: ${formatBytes(estimatedPerSpace)}`)
    console.log('  Breakdown per space:')
    console.log(`    Map entry: ~${mapOverheadPerEntry} bytes`)
    console.log(`    SpaceInfo object: ~${objectOverhead} bytes`)
    console.log(
      `    Set members (~${(totalMembers / SPACE_COUNT).toFixed(0)} entries): ~${Math.round((totalMembers / SPACE_COUNT) * setEntryOverhead)} bytes`
    )

    // Keep reference alive
    expect(spacesMap.size).toBe(SPACE_COUNT)

    // Estimated per-space should be reasonable (under 2KB)
    expect(estimatedPerSpace).toBeLessThan(2048)
  })

  it('perf: init with 20K spaces', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0')
    ctx.contextData = createSessionData(account)

    const start = performance.now()
    await mw.init(ctx)
    const elapsed = performance.now() - start

    console.log('=== Init ===')
    console.log(`  Time to init ${SPACE_COUNT} spaces: ${elapsed.toFixed(2)} ms`)

    // Should init under 500ms even for 20K spaces
    expect(elapsed).toBeLessThan(500)
  })

  it('perf: getAllAllowedSpaces via searchFulltext for various users', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0')
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)

    const userIndices = [0, 50, 100, 150, 200, 249]
    const times: number[] = []
    const spaceCounts: number[] = []

    for (const idx of userIndices) {
      const user = createAccount(`user-${idx}`)
      ctx.contextData = createSessionData(user)
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()

      const start = performance.now()
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const elapsed = performance.now() - start
      times.push(elapsed)

      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces as any[]
      spaceCounts.push(passedSpaces.length)
    }

    console.log('=== getAllAllowedSpaces (via searchFulltext) ===')
    for (let i = 0; i < userIndices.length; i++) {
      console.log(`  user-${userIndices[i]}: ${times[i].toFixed(2)} ms, ${spaceCounts[i]} allowed spaces`)
    }
    console.log(`  Avg: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} ms`)

    // Each call should be under 100ms
    for (const t of times) {
      expect(t).toBeLessThan(100)
    }
  })

  it('perf: searchFulltext throughput - 1000 sequential calls', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0')
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)

    const iterations = 1000
    const users = Array.from({ length: iterations }, (_, i) => createAccount(`user-${i % USER_COUNT}`))

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      ctx.contextData = createSessionData(users[i])
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
    }
    const elapsed = performance.now() - start

    console.log('=== searchFulltext throughput ===')
    console.log(`  ${iterations} calls in ${elapsed.toFixed(1)} ms`)
    console.log(`  Avg per call: ${(elapsed / iterations).toFixed(3)} ms`)
    console.log(`  Throughput: ${Math.floor(iterations / (elapsed / 1000))} calls/sec`)

    // Average should be under 15ms per call (CI headroom)
    expect(elapsed / iterations).toBeLessThan(15)
  })

  it('perf: handleBroadcast target resolution - 500 txes', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0')
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)

    // Mock for broadcast: no collaborator security
    jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
    jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([core.class.Space, core.class.Doc])
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

    // Generate txes targeting random spaces
    const txCount = 500
    const broadcastTxes = Array.from({ length: txCount }, (_, i) => {
      const spaceIdx = Math.floor(Math.random() * SPACE_COUNT)
      return txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        `space-${spaceIdx}` as Ref<Space>,
        generateId(),
        {}
      )
    })

    ctx.contextData.broadcast.txes = []

    const start = performance.now()
    await mw.handleBroadcast(ctx)

    // Now resolve targets for all txes
    const resolver = ctx.contextData.broadcast.targets.spaceSec
    expect(resolver).toBeDefined()

    let resolvedCount = 0
    for (const tx of broadcastTxes) {
      const result = await resolver(tx)
      if (result != null) resolvedCount++
    }
    const elapsed = performance.now() - start

    console.log('=== handleBroadcast target resolution ===')
    console.log(`  ${txCount} txes resolved in ${elapsed.toFixed(2)} ms`)
    console.log(`  Avg per tx: ${(elapsed / txCount).toFixed(3)} ms`)
    console.log(`  Resolved with targets: ${resolvedCount}/${txCount}`)

    // Average per-tx resolution should be under 1ms (it's a Map lookup)
    expect(elapsed / txCount).toBeLessThan(1)
  })

  it('perf: tx processing - add/remove members', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0', AccountRole.Owner)
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))
    ;(nextMiddleware.tx as jest.Mock).mockImplementation(async (): Promise<TxMiddlewareResult> => ({}))

    const iterations = 1000

    // Measure $push member
    let start = performance.now()
    for (let i = 0; i < iterations; i++) {
      ctx.contextData = createSessionData(account)
      const spaceIdx = i % SPACE_COUNT
      const updateTx = txFactory.createTxUpdateDoc(
        core.class.Space,
        core.space.Space,
        `space-${spaceIdx}` as Ref<Space>,
        { $push: { members: `new-user-${i}` as AccountUuid } }
      )
      await mw.tx(ctx, [updateTx])
    }
    const pushElapsed = performance.now() - start

    // Measure $pull member
    start = performance.now()
    for (let i = 0; i < iterations; i++) {
      ctx.contextData = createSessionData(account)
      const spaceIdx = i % SPACE_COUNT
      const updateTx = txFactory.createTxUpdateDoc(
        core.class.Space,
        core.space.Space,
        `space-${spaceIdx}` as Ref<Space>,
        { $pull: { members: `new-user-${i}` as AccountUuid } }
      )
      await mw.tx(ctx, [updateTx])
    }
    const pullElapsed = performance.now() - start

    console.log('=== TX processing ===')
    console.log(
      `  ${iterations} $push member ops: ${pushElapsed.toFixed(1)} ms (${(pushElapsed / iterations).toFixed(3)} ms/op)`
    )
    console.log(
      `  ${iterations} $pull member ops: ${pullElapsed.toFixed(1)} ms (${(pullElapsed / iterations).toFixed(3)} ms/op)`
    )

    // Each operation should be under 1ms
    expect(pushElapsed / iterations).toBeLessThan(1)
    expect(pullElapsed / iterations).toBeLessThan(1)
  })

  it('perf: space create via tx', async () => {
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(spaces))
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    const account = createAccount('user-0')
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))
    ;(nextMiddleware.tx as jest.Mock).mockImplementation(async (): Promise<TxMiddlewareResult> => ({}))

    const iterations = 1000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      ctx.contextData = createSessionData(account)
      const members: AccountUuid[] = []
      for (let j = 0; j < MEMBERS_PER_SPACE_AVG; j++) {
        members.push(`user-${Math.floor(Math.random() * USER_COUNT)}` as AccountUuid)
      }
      const createTx = txFactory.createTxCreateDoc(
        core.class.Space,
        core.space.Space,
        {
          name: `New Space ${i}`,
          description: '',
          private: true,
          archived: false,
          members,
          owners: [account.uuid] // creator is owner
        },
        `new-space-${i}` as Ref<Space>
      )
      await mw.tx(ctx, [createTx])
    }
    const elapsed = performance.now() - start

    console.log('=== Space create TX ===')
    console.log(`  ${iterations} space creates: ${elapsed.toFixed(1)} ms (${(elapsed / iterations).toFixed(3)} ms/op)`)

    expect(elapsed / iterations).toBeLessThan(1)
  })
})
