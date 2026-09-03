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
  systemAccountUuid,
  toFindResult,
  type TxCreateDoc,
  TxFactory,
  WorkspaceEvent,
  type BroadcastTargetResult,
  type ClassCollaborators,
  type Collaborator
} from '@hcengineering/core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'
import { SpaceSecurityMiddleware } from '../spaceSecurity'
import contact from '@hcengineering/contact'

// Test space class refs
const testSpaceClass = core.class.Space

function createAccount (uuid: string, role: AccountRole = AccountRole.User): Account {
  return {
    uuid: uuid as AccountUuid,
    role,
    primarySocialId: `social:${uuid}` as any,
    socialIds: [`social:${uuid}`] as any,
    fullSocialIds: [{ _id: `social:${uuid}` as any, type: 'email' as any, value: `${uuid}@test.com` }] as any
  }
}

function createSessionData (account: Account, overrides: Partial<SessionData> = {}): SessionData {
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
    socialStringsToUsers: new Map(),
    ...overrides
  } as any
}

function createSpace (
  id: string,
  members: string[],
  opts: {
    private?: boolean
    archived?: boolean
    _class?: Ref<Class<Space>>
    owners?: string[]
    autoJoin?: boolean
  } = {}
): Space {
  return {
    _id: id as Ref<Space>,
    _class: opts._class ?? testSpaceClass,
    space: core.space.Space,
    name: `Space ${id}`,
    description: '',
    private: opts.private ?? false,
    archived: opts.archived ?? false,
    members: members as AccountUuid[],
    owners: (opts.owners as AccountUuid[]) ?? [],
    autoJoin: opts.autoJoin,
    createdBy: core.account.System,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } satisfies Space
}

describe('SpaceSecurityMiddleware', () => {
  let ctx: MeasureContext<SessionData>
  let hierarchy: Hierarchy
  let modelDb: ModelDb
  let pipelineContext: PipelineContext
  let txFactory: TxFactory
  let nextMiddleware: Middleware
  let nextFindAllResult: any[]

  beforeEach(() => {
    hierarchy = new Hierarchy()
    modelDb = new ModelDb(hierarchy)

    // Mock hierarchy.isDerived to handle core.class.Space checks
    const origIsDerived = hierarchy.isDerived.bind(hierarchy)
    jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
      if (_class === core.class.Space && from === core.class.Space) return true
      if (_class === testSpaceClass && from === core.class.Space) return true
      if (_class === core.class.SystemSpace && from === core.class.Space) return true
      try {
        return origIsDerived(_class, from)
      } catch {
        return _class === from
      }
    })

    nextFindAllResult = []

    pipelineContext = {
      workspace: { uuid: 'test-workspace' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb,
      branding: null as any,
      adapterManager: {} as any,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: ''
    }

    nextMiddleware = {
      findAll: jest.fn(async () => toFindResult(nextFindAllResult)),
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

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function createMiddleware (spaces: Space[] = []): Promise<SpaceSecurityMiddleware> {
    nextFindAllResult = spaces
    const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
    // Trigger init
    const account = createAccount('user1')
    ctx.contextData = createSessionData(account)
    await mw.init(ctx)
    // Reset mock so tests can set their own results
    ;(nextMiddleware.findAll as jest.Mock).mockClear()
    nextFindAllResult = []
    ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(nextFindAllResult))
    return mw
  }

  describe('init', () => {
    it('should load spaces on first init and not reload on subsequent calls', async () => {
      const spaces = [
        createSpace('space1', ['user1'], { private: true }),
        createSpace('space2', ['user2'], { private: false })
      ]
      nextFindAllResult = spaces
      const mw = await SpaceSecurityMiddleware.create(ctx, pipelineContext, nextMiddleware)
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      await mw.init(ctx)
      expect(nextMiddleware.findAll).toHaveBeenCalledTimes(1)

      // Second init should not reload
      await mw.init(ctx)
      expect(nextMiddleware.findAll).toHaveBeenCalledTimes(1)
    })

    it('should categorize system spaces separately', async () => {
      const spaces = [
        createSpace('sys1', [], { _class: core.class.SystemSpace }),
        createSpace('regular1', ['user1'], { private: false })
      ]
      const mw = await createMiddleware(spaces)

      // System spaces should be accessible in getAllAllowedSpaces (via searchFulltext)
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })

      const searchCall = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0]
      const passedQuery = searchCall[1]
      expect(passedQuery.spaces).toContain('sys1' as Ref<Space>)
      expect(passedQuery.spaces).toContain('regular1' as Ref<Space>)
    })
  })

  describe('spacesMap with Set members', () => {
    it('should store members as Set internally and support membership checks', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: true })])

      // user1 is a member - should see space1 via searchFulltext
      const user1 = createAccount('user1')
      ctx.contextData = createSessionData(user1)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      let passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('space1' as Ref<Space>)

      // user3 is not a member of private space1 - should NOT see it
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user3 = createAccount('user3')
      ctx.contextData = createSessionData(user3)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })

    it('should include public spaces for non-readonly-guest users', async () => {
      const mw = await createMiddleware([
        createSpace('public1', ['user1'], { private: false }),
        createSpace('private1', ['user1'], { private: true })
      ])

      // user2 is not a member but should see public space
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('public1' as Ref<Space>)
      expect(passedSpaces).not.toContain('private1' as Ref<Space>)
    })

    it('should exclude public spaces for ReadOnlyGuest', async () => {
      const mw = await createMiddleware([createSpace('public1', [], { private: false })])

      const guest = createAccount('guest1', AccountRole.ReadOnlyGuest)
      ctx.contextData = createSessionData(guest)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('public1' as Ref<Space>)
    })

    it('should let workspace Owner see private spaces they are not a member of', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const owner = createAccount('owner1', AccountRole.Owner)
      ctx.contextData = createSessionData(owner)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('private1' as Ref<Space>)
    })
  })

  describe('handleCreate', () => {
    it('should add new space to spacesMap when TxCreateDoc for space is processed', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'New Space',
          description: '',
          private: true,
          archived: false,
          members: ['user1' as AccountUuid],
          owners: ['user1' as AccountUuid] // creator is owner
        },
        'newSpace' as Ref<Space>
      )

      await mw.tx(ctx, [createTx])

      // Now user1 should see newSpace
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('newSpace' as Ref<Space>)
    })
  })

  describe('handleUpdate - member operations', () => {
    it('should add members via $push', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Push user2 as a member
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user2' as AccountUuid }
      })

      await mw.tx(ctx, [updateTx])

      // user2 should now see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('space1' as Ref<Space>)
    })

    it('should remove members via $pull', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Pull user2 from members
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: 'user2' as AccountUuid }
      })

      await mw.tx(ctx, [updateTx])

      // user2 should no longer see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })

    it('should sync members when members array is replaced', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Replace members entirely
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        members: ['user1' as AccountUuid, 'user3' as AccountUuid]
      })

      await mw.tx(ctx, [updateTx])

      // user3 should now see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user3 = createAccount('user3')
      ctx.contextData = createSessionData(user3)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      let passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('space1' as Ref<Space>)

      // user2 should no longer see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })

    it('should handle private flag change', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Make space private
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      await mw.tx(ctx, [updateTx])

      // user2 (non-member) should no longer see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })

    it('should handle archived flag change', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false, archived: false })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Archive the space
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        archived: true
      })

      await mw.tx(ctx, [updateTx])

      // With showArchived=false (default in searchFulltext), archived spaces should be excluded
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })
  })

  describe('handleRemove', () => {
    it('should remove space from spacesMap', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)

      await mw.tx(ctx, [removeTx])

      // user1 should no longer see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })
  })

  describe('searchFulltext', () => {
    it('should not filter spaces for system account', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const systemAccount = createAccount(systemAccountUuid)
      ctx.contextData = createSessionData(systemAccount)

      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedQuery = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1]
      // System account should not have spaces filter applied
      expect(passedQuery.spaces).toBeUndefined()
    })

    it('should exclude system spaces for Guest in search', async () => {
      const mw = await createMiddleware([createSpace('sys1', [], { _class: core.class.SystemSpace })])

      const guest = createAccount('guest1', AccountRole.Guest)
      ctx.contextData = createSessionData(guest)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('sys1' as Ref<Space>)
    })

    it('should include system spaces for regular users in search', async () => {
      const mw = await createMiddleware([createSpace('sys1', [], { _class: core.class.SystemSpace })])

      const user = createAccount('user1', AccountRole.User)
      ctx.contextData = createSessionData(user)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      // forSearch=true but user is not Guest/ReadOnlyGuest, so system spaces included
      expect(passedSpaces).toContain('sys1' as Ref<Space>)
    })
  })

  describe('getAllAllowedSpaces', () => {
    it('should always include main spaces', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces as Ref<Space>[]

      // Main spaces should always be included
      expect(passedSpaces).toContain(core.space.Configuration)
      expect(passedSpaces).toContain(core.space.Model)
      expect(passedSpaces).toContain(core.space.Space)
    })

    it('should include account uuid as a space ref', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      const passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces as Ref<Space>[]

      // Account uuid is added as a pseudo-space ref
      expect(passedSpaces).toContain('user1' as unknown as Ref<Space>)
    })
  })

  describe('broadcast events', () => {
    it('should emit SecurityChange event when members are added', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user2' as AccountUuid }
      })

      await mw.tx(ctx, [updateTx])

      // Check that a SecurityChange broadcast event was emitted
      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBeGreaterThan(0)
    })

    it('should emit SecurityChange event when members are removed', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: 'user2' as AccountUuid }
      })

      await mw.tx(ctx, [updateTx])

      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBeGreaterThan(0)
    })

    it('should emit SecurityChange for all active users on archive change', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false })])

      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1' as any, { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:user2' as any, { accountUuid: 'user2' as AccountUuid, role: AccountRole.User })

      ctx.contextData = createSessionData(account, { socialStringsToUsers } as any)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        archived: true
      })

      await mw.tx(ctx, [updateTx])

      // Should have broadcast targets for the archive change
      const securityTxes = ctx.contextData.broadcast.txes.filter((tx: any) => tx._class === core.class.TxWorkspaceEvent)
      expect(securityTxes.length).toBeGreaterThan(0)
    })

    it('should emit SecurityChange WITHOUT a target callback when private flips public->private', async () => {
      // Receivers that need the refresh (non-members in other sessions) are
      // not in this request's socialStringsToUsers, so the SecurityChange tx
      // must be broadcast globally — i.e. without a per-tx target resolver.
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      await mw.tx(ctx, [updateTx])

      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBe(1)
      const securityTxId = securityTxes[0]._id
      // No targets resolver was registered for this tx id.
      const targetEntries = Object.entries(ctx.contextData.broadcast.targets ?? {})
      const matchingTarget = targetEntries.find(([k]) => k.includes(securityTxId))
      expect(matchingTarget).toBeUndefined()
    })

    it('should emit SecurityChange WITHOUT a target callback when private flips private->public', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: false
      })

      await mw.tx(ctx, [updateTx])

      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBe(1)
      const securityTxId = securityTxes[0]._id
      const targetEntries = Object.entries(ctx.contextData.broadcast.targets ?? {})
      const matchingTarget = targetEntries.find(([k]) => k.includes(securityTxId))
      expect(matchingTarget).toBeUndefined()
    })
  })

  describe('handleBroadcast - spaceSec target resolution', () => {
    it('should set spaceSec broadcast target resolver for space members', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      // Simulate broadcast with a tx targeting space1
      const someTx = txFactory.createTxUpdateDoc(testSpaceClass, 'space1' as Ref<Space>, generateId(), {})
      // Clear objectClass check — make it non-Space for broadcast resolver
      ;(someTx as any).objectClass = testSpaceClass
      ctx.contextData.broadcast.txes = [someTx]

      // Mock findAll for Collaborator lookups
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      // Mock hierarchy for processTx — someTx is a Space update
      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (_class === testSpaceClass && from === core.class.Space) return true
        if (_class === core.class.Space && from === core.class.Space) return true
        if (from === core.class.Collaborator) return false
        return _class === from
      })

      // Mock getClassCollaborators by mocking modelDb.findAllSync
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))

      // Mock getAncestors to avoid 'ancestors not found' error
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc as any])

      await mw.handleBroadcast(ctx)

      // spaceSec target resolver should be set
      expect(ctx.contextData.broadcast.targets.spaceSec).toBeDefined()

      // Call the resolver with the tx — use a non-Space tx targeting space1
      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )
      // getClassCollaborators will use getAncestors which is mocked
      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      // For space with members, should return target list
      expect(result).toBeDefined()
      expect((result as BroadcastTargetResult)?.target).toBeDefined()
      if ((result as BroadcastTargetResult)?.target != null) {
        expect((result as BroadcastTargetResult).target).toContain('user1' as AccountUuid)
        expect((result as BroadcastTargetResult).target).toContain('user2' as AccountUuid)
      }
    })

    it('should restrict public space broadcast to members only for objects', async () => {
      // Public space with members [user1] - object broadcast must restrict to members
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false })])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )
      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toBeDefined()
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).not.toContain('user2' as AccountUuid)
    })

    it('should broadcast space-level updates to ALL users for public spaces', async () => {
      // Space-level updates for public spaces must broadcast to all, so users can see and join them
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false })])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) {
          return _class === testSpaceClass
        }
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const spaceTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        name: 'Updated Public Space'
      })
      const result = await ctx.contextData.broadcast.targets.spaceSec(spaceTx)
      expect(result).toBeUndefined()
    })

    it('should still restrict private space broadcast to members only', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: true })])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc as any])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )
      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toBeDefined()
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).toContain('user2' as AccountUuid)
      expect(target).not.toContain('user3' as AccountUuid)
    })

    it('should NOT include workspace Owner in private space broadcast targets for objects if they are not a member', async () => {
      // Owner is not in space.members but can see every private space, however they
      // should not receive live updates for non-space objects within private spaces
      // unless they are members.
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: true })])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:owner1', {
        accountUuid: 'owner1' as AccountUuid,
        role: AccountRole.Owner
      })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )
      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).not.toContain('owner1' as AccountUuid)
      expect(target).toContain('user1' as AccountUuid)
    })

    it('should NOT include workspace Owner in personal space broadcast targets if they are not a member', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1'], { private: true, _class: contact.class.PersonSpace })
      ])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:owner1', {
        accountUuid: 'owner1' as AccountUuid,
        role: AccountRole.Owner
      })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === contact.class.PersonSpace) {
          return _class === contact.class.PersonSpace
        }
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([contact.class.PersonSpace, testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )
      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).not.toContain('owner1' as AccountUuid)
    })

    it('should broadcast private space creation and updates only to members and owners', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:owner1', {
        accountUuid: 'owner1' as AccountUuid,
        role: AccountRole.Owner
      })
      socialStringsToUsers.set('social:user2', { accountUuid: 'user2' as AccountUuid, role: AccountRole.User })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) {
          return _class === testSpaceClass
        }
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      // Test creation transaction of the private space itself
      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Private Space',
          description: '',
          archived: false,
          private: true,
          members: ['user1' as AccountUuid],
          owners: ['user1' as AccountUuid]
        },
        'space1' as Ref<Space>
      )
      const createResult = await ctx.contextData.broadcast.targets.spaceSec(createTx)
      const createTarget = (createResult as BroadcastTargetResult)?.target
      expect(createTarget).toBeDefined()
      expect(createTarget).toContain('user1' as AccountUuid)
      expect(createTarget).toContain('owner1' as AccountUuid)
      expect(createTarget).not.toContain('user2' as AccountUuid)

      // Test update transaction of the private space itself
      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        name: 'Updated Private Space'
      })
      const updateResult = await ctx.contextData.broadcast.targets.spaceSec(updateTx)
      const updateTarget = (updateResult as BroadcastTargetResult)?.target
      expect(updateTarget).toBeDefined()
      expect(updateTarget).toContain('user1' as AccountUuid)
      expect(updateTarget).toContain('owner1' as AccountUuid)
      expect(updateTarget).not.toContain('user2' as AccountUuid)

      // Test deletion transaction of the private space itself
      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)
      const deletedSpace = createSpace('space1', ['user1'], { private: true, owners: ['user1'] })
      ctx.contextData.removedMap.set('space1' as Ref<Space>, deletedSpace)
      await mw.tx(ctx, [removeTx])

      const removeResult = await ctx.contextData.broadcast.targets.spaceSec(removeTx)
      const removeTarget = (removeResult as BroadcastTargetResult)?.target
      expect(removeTarget).toBeDefined()
      expect(removeTarget).toContain('user1' as AccountUuid)
      expect(removeTarget).toContain('owner1' as AccountUuid)
      expect(removeTarget).not.toContain('user2' as AccountUuid)
    })

    it('should broadcast personal space creation and updates only to members', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1'], { private: true, _class: contact.class.PersonSpace, owners: ['user1'] })
      ])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:owner1', {
        accountUuid: 'owner1' as AccountUuid,
        role: AccountRole.Owner
      })
      socialStringsToUsers.set('social:user2', { accountUuid: 'user2' as AccountUuid, role: AccountRole.User })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) {
          return _class === testSpaceClass || _class === contact.class.PersonSpace
        }
        if (from === core.class.Collaborator) return false
        if (from === contact.class.PersonSpace) {
          return _class === contact.class.PersonSpace
        }
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([contact.class.PersonSpace, testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      // Test creation transaction of the personal space itself
      const createTx = txFactory.createTxCreateDoc(
        contact.class.PersonSpace,
        core.space.Space,
        {
          name: 'Personal Space',
          description: '',
          archived: false,
          private: true,
          members: ['user1' as AccountUuid],
          owners: ['user1' as AccountUuid]
        },
        'space1' as Ref<Space>
      )
      const createResult = await ctx.contextData.broadcast.targets.spaceSec(createTx)
      const createTarget = (createResult as BroadcastTargetResult)?.target
      expect(createTarget).toBeDefined()
      expect(createTarget).toContain('user1' as AccountUuid)
      expect(createTarget).not.toContain('owner1' as AccountUuid)
      expect(createTarget).not.toContain('user2' as AccountUuid)

      // Test update transaction of the personal space itself
      const updateTx = txFactory.createTxUpdateDoc(
        contact.class.PersonSpace,
        core.space.Space,
        'space1' as Ref<Space>,
        { name: 'Updated Personal Space' }
      )
      const updateResult = await ctx.contextData.broadcast.targets.spaceSec(updateTx)
      const updateTarget = (updateResult as BroadcastTargetResult)?.target
      expect(updateTarget).toBeDefined()
      expect(updateTarget).toContain('user1' as AccountUuid)
      expect(updateTarget).not.toContain('owner1' as AccountUuid)
      expect(updateTarget).not.toContain('user2' as AccountUuid)

      // Test deletion transaction of the personal space itself
      const removeTx = txFactory.createTxRemoveDoc(contact.class.PersonSpace, core.space.Space, 'space1' as Ref<Space>)
      const deletedSpace = createSpace('space1', ['user1'], {
        private: true,
        _class: contact.class.PersonSpace,
        owners: ['user1']
      })
      ctx.contextData.removedMap.set('space1' as Ref<Space>, deletedSpace)
      await mw.tx(ctx, [removeTx])

      const removeResult = await ctx.contextData.broadcast.targets.spaceSec(removeTx)
      const removeTarget = (removeResult as BroadcastTargetResult)?.target
      expect(removeTarget).toBeDefined()
      expect(removeTarget).toContain('user1' as AccountUuid)
      expect(removeTarget).not.toContain('owner1' as AccountUuid)
      expect(removeTarget).not.toContain('user2' as AccountUuid)
    })

    it('should return undefined for unknown spaces', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))

      await mw.handleBroadcast(ctx)

      const someTx = txFactory.createTxUpdateDoc(
        'test:class:TestDoc' as Ref<Class<Doc>>,
        'unknown-space' as Ref<Space>,
        generateId(),
        {}
      )
      const result = await ctx.contextData.broadcast.targets.spaceSec(someTx)
      expect(result).toBeUndefined()
    })

    it('should broadcast public space deletion to ALL users', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: false })])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) {
          return _class === testSpaceClass
        }
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)
      const deletedSpace = createSpace('space1', ['user1'], { private: false })
      ctx.contextData.removedMap.set('space1' as Ref<Space>, deletedSpace)
      await mw.tx(ctx, [removeTx])

      const result = await ctx.contextData.broadcast.targets.spaceSec(removeTx)
      expect(result).toBeUndefined()
    })

    it('should exclude guests who are not collaborators for system space updates with collab security', async () => {
      const mw = await createMiddleware([createSpace('sys1', [], { _class: core.class.SystemSpace })])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:guest1', { accountUuid: 'guest1' as AccountUuid, role: AccountRole.Guest })
      socialStringsToUsers.set('social:guest2', { accountUuid: 'guest2' as AccountUuid, role: AccountRole.Guest })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return _class === core.class.Collaborator
        return _class === from
      })

      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue(['test:class:SomeDoc' as any, core.class.Doc])

      const ClassCollaboratorsClass = core.class.ClassCollaborators
      const collabSecObj: ClassCollaborators<Doc> = {
        _id: 'collabSec1' as Ref<ClassCollaborators<Doc>>,
        _class: core.class.ClassCollaborators,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        attachedTo: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        provideSecurity: true,
        fields: []
      }
      jest.spyOn(modelDb, 'findAllSync').mockImplementation((_class: any, query: any): any => {
        if (_class === ClassCollaboratorsClass) {
          return toFindResult([collabSecObj])
        }
        return toFindResult([])
      })

      const guest1Collab: Collaborator = {
        _id: 'collab1' as Ref<Collaborator>,
        _class: core.class.Collaborator,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        collaborator: 'guest1' as AccountUuid,
        attachedToClass: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        attachedTo: 'doc1' as Ref<Doc>,
        collection: 'collaborators'
      }
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async (_ctx, _class) => {
        if (_class === core.class.Collaborator) {
          return toFindResult([guest1Collab])
        }
        return toFindResult([])
      })

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'sys1' as Ref<Space>,
        'doc1' as Ref<Doc>,
        {}
      )

      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toEqual({ exclude: ['guest2' as AccountUuid] })
    })

    it('should include guest collaborators in targets for private space object updates with collab security', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:guest1', { accountUuid: 'guest1' as AccountUuid, role: AccountRole.Guest })
      socialStringsToUsers.set('social:guest2', { accountUuid: 'guest2' as AccountUuid, role: AccountRole.Guest })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return _class === core.class.Collaborator
        return _class === from
      })

      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue(['test:class:SomeDoc' as any, core.class.Doc])

      const ClassCollaboratorsClass = core.class.ClassCollaborators
      const collabSecObj: ClassCollaborators<Doc> = {
        _id: 'collabSec1' as Ref<ClassCollaborators<Doc>>,
        _class: core.class.ClassCollaborators,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        attachedTo: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        provideSecurity: true,
        fields: []
      }
      jest.spyOn(modelDb, 'findAllSync').mockImplementation((_class: any, query: any): any => {
        if (_class === ClassCollaboratorsClass) {
          return toFindResult([collabSecObj])
        }
        return toFindResult([])
      })

      const guest1Collab: Collaborator = {
        _id: 'collab1' as Ref<Collaborator>,
        _class: core.class.Collaborator,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        collaborator: 'guest1' as AccountUuid,
        attachedToClass: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        attachedTo: 'doc1' as Ref<Doc>,
        collection: 'collaborators'
      }
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async (_ctx, _class) => {
        if (_class === core.class.Collaborator) {
          return toFindResult([guest1Collab])
        }
        return toFindResult([])
      })

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        'doc1' as Ref<Doc>,
        {}
      )

      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toBeDefined()
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).toContain('guest1' as AccountUuid)
      expect(target).not.toContain('guest2' as AccountUuid)
    })

    it('should include guest collaborators in targets for private space object updates attached to another object with collab security', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])
      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:user1', { accountUuid: 'user1' as AccountUuid, role: AccountRole.User })
      socialStringsToUsers.set('social:guest1', { accountUuid: 'guest1' as AccountUuid, role: AccountRole.Guest })
      socialStringsToUsers.set('social:guest2', { accountUuid: 'guest2' as AccountUuid, role: AccountRole.Guest })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return _class === core.class.Collaborator
        return _class === from
      })

      jest.spyOn(hierarchy, 'getAncestors').mockImplementation((_class: any) => {
        if (_class === 'test:class:ChildDoc') {
          return ['test:class:ChildDoc' as any, core.class.Doc]
        }
        if (_class === 'test:class:ParentDoc') {
          return ['test:class:ParentDoc' as any, core.class.Doc]
        }
        return [_class, core.class.Doc]
      })

      const ClassCollaboratorsClass = core.class.ClassCollaborators
      const collabSecObj: ClassCollaborators<Doc> = {
        _id: 'collabSec1' as Ref<ClassCollaborators<Doc>>,
        _class: core.class.ClassCollaborators,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        attachedTo: 'test:class:ParentDoc' as Ref<Class<Doc>>,
        provideSecurity: true,
        fields: []
      }
      jest.spyOn(modelDb, 'findAllSync').mockImplementation((_class: unknown, query: unknown): any => {
        if (_class === ClassCollaboratorsClass) {
          const q = query as { attachedTo?: { $in?: string[] } } | undefined
          if (q?.attachedTo?.$in?.includes('test:class:ParentDoc') === true) {
            return toFindResult([collabSecObj])
          }
        }
        return toFindResult([])
      })

      const guest1Collab: Collaborator = {
        _id: 'collab1' as Ref<Collaborator>,
        _class: core.class.Collaborator,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        collaborator: 'guest1' as AccountUuid,
        attachedToClass: 'test:class:ParentDoc' as Ref<Class<Doc>>,
        attachedTo: 'parent1' as Ref<Doc>,
        collection: 'collaborators'
      }
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async (_ctx, _class) => {
        if (_class === core.class.Collaborator) {
          return toFindResult([guest1Collab])
        }
        return toFindResult([])
      })

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:ChildDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        'doc1' as Ref<Doc>,
        {}
      )
      ;(docTx as any).attachedTo = 'parent1'
      ;(docTx as any).attachedToClass = 'test:class:ParentDoc'

      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toBeDefined()
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).toContain('guest1' as AccountUuid)
      expect(target).not.toContain('guest2' as AccountUuid)
    })

    it('should use removedMap to resolve space security targets for a document transaction in a deleted space', async () => {
      const mw = await createMiddleware([])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      // Mock hierarchy to return false for Space/Collaborator checks (since it's a doc Tx)
      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) return false
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const docTx = txFactory.createTxUpdateDoc(
        'test:class:SomeDoc' as Ref<Class<Doc>>,
        'space1' as Ref<Space>,
        generateId(),
        {}
      )

      // space1 is deleted, so it's not in spacesMap, but is in removedMap
      const deletedSpace = createSpace('space1', ['user1', 'user2'], { private: true })
      ctx.contextData.removedMap.set('space1' as Ref<Space>, deletedSpace)

      const result = await ctx.contextData.broadcast.targets.spaceSec(docTx)
      expect(result).toBeDefined()
      const target = (result as BroadcastTargetResult)?.target
      expect(target).toBeDefined()
      expect(target).toContain('user1' as AccountUuid)
      expect(target).toContain('user2' as AccountUuid)
    })

    it('should return undefined for space transactions of unknown spaces', async () => {
      const mw = await createMiddleware([])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)
      ctx.contextData.broadcast.txes = []

      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (from === core.class.Space) {
          return _class === testSpaceClass
        }
        if (from === core.class.Collaborator) return false
        return _class === from
      })
      jest.spyOn(modelDb, 'findAllSync').mockReturnValue(toFindResult([]))
      jest.spyOn(hierarchy, 'getAncestors').mockReturnValue([testSpaceClass, core.class.Doc])
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult([]))

      await mw.handleBroadcast(ctx)

      const spaceTx = txFactory.createTxUpdateDoc(
        testSpaceClass,
        'non-main-space' as Ref<Space>,
        'unknown-space' as Ref<Space>,
        {}
      )

      const result = await ctx.contextData.broadcast.targets.spaceSec(spaceTx)
      expect(result).toBeUndefined()
    })
  })

  describe('handeCollaborator', () => {
    it('should broadcast SecurityChange when a collaborator is created for a class with provideSecurity', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:guest1', { accountUuid: 'guest1' as AccountUuid, role: AccountRole.Guest })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)

      // Mock ClassCollaborators finding
      const ClassCollaboratorsClass = core.class.ClassCollaborators
      const collabSecObj: ClassCollaborators<Doc> = {
        _id: 'collabSec1' as Ref<ClassCollaborators<Doc>>,
        _class: core.class.ClassCollaborators,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        attachedTo: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        provideSecurity: true,
        fields: []
      }
      jest.spyOn(modelDb, 'findAllSync').mockImplementation((_class: unknown): any => {
        if (_class === ClassCollaboratorsClass) {
          return toFindResult([collabSecObj])
        }
        return toFindResult([])
      })

      // Mock hierarchy.isDerived so core.class.Collaborator checks pass
      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (_class === core.class.Collaborator && from === core.class.Collaborator) return true
        return false
      })

      const createTx = txFactory.createTxCreateDoc(
        core.class.Collaborator,
        core.space.Space,
        {
          collaborator: 'guest1' as AccountUuid,
          attachedToClass: 'test:class:SomeDoc' as Ref<Class<Doc>>,
          attachedTo: 'doc1' as Ref<Doc>,
          collection: 'collaborators'
        },
        'collab1' as Ref<Collaborator>
      )

      await mw.tx(ctx, [createTx])

      // Should have broadcast target for the collaborator change
      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBe(1)

      const targetResolver = ctx.contextData.broadcast.targets['security' + securityTxes[0]._id]
      expect(targetResolver).toBeDefined()
      if (targetResolver !== undefined) {
        const resolverResult = await targetResolver(securityTxes[0])
        expect(resolverResult).toBeDefined()
        const targetResult = resolverResult as BroadcastTargetResult
        expect(targetResult.target).toContain('guest1' as AccountUuid)
      }
    })

    it('should broadcast SecurityChange when a collaborator is removed for a class with provideSecurity', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      const socialStringsToUsers = new Map<string, { accountUuid: AccountUuid, role: AccountRole }>()
      socialStringsToUsers.set('social:guest1', { accountUuid: 'guest1' as AccountUuid, role: AccountRole.Guest })
      ctx.contextData = createSessionData(account, { socialStringsToUsers } as unknown as Partial<SessionData>)

      // Mock ClassCollaborators finding
      const ClassCollaboratorsClass = core.class.ClassCollaborators
      const collabSecObj: ClassCollaborators<Doc> = {
        _id: 'collabSec1' as Ref<ClassCollaborators<Doc>>,
        _class: core.class.ClassCollaborators,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        attachedTo: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        provideSecurity: true,
        fields: []
      }
      jest.spyOn(modelDb, 'findAllSync').mockImplementation((_class: unknown): any => {
        if (_class === ClassCollaboratorsClass) {
          return toFindResult([collabSecObj])
        }
        return toFindResult([])
      })

      // Mock hierarchy.isDerived so core.class.Collaborator checks pass
      jest.spyOn(hierarchy, 'isDerived').mockImplementation((_class, from) => {
        if (_class === core.class.Collaborator && from === core.class.Collaborator) return true
        return false
      })

      const guest1Collab: Collaborator = {
        _id: 'collab1' as Ref<Collaborator>,
        _class: core.class.Collaborator,
        space: core.space.Space,
        modifiedOn: Date.now(),
        modifiedBy: core.account.System,
        collaborator: 'guest1' as AccountUuid,
        attachedToClass: 'test:class:SomeDoc' as Ref<Class<Doc>>,
        attachedTo: 'doc1' as Ref<Doc>,
        collection: 'collaborators'
      }

      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async (_ctx, _class) => {
        if (_class === core.class.Collaborator) {
          return toFindResult([guest1Collab])
        }
        return toFindResult([])
      })

      const removeTx = txFactory.createTxRemoveDoc(
        core.class.Collaborator,
        core.space.Space,
        'collab1' as Ref<Collaborator>
      )

      await mw.tx(ctx, [removeTx])

      // Should have broadcast target for the collaborator change
      const securityTxes = ctx.contextData.broadcast.txes.filter(
        (tx: any) => tx._class === core.class.TxWorkspaceEvent && tx.event === WorkspaceEvent.SecurityChange
      )
      expect(securityTxes.length).toBe(1)

      const targetResolver = ctx.contextData.broadcast.targets['security' + securityTxes[0]._id]
      expect(targetResolver).toBeDefined()
      if (targetResolver !== undefined) {
        const resolverResult = await targetResolver(securityTxes[0])
        expect(resolverResult).toBeDefined()
        const targetResult = resolverResult as BroadcastTargetResult
        expect(targetResult.target).toContain('guest1' as AccountUuid)
      }
    })
  })

  describe('findAll - lookup filtering', () => {
    it('should pass through findAll to next middleware', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      nextFindAllResult = [{ _id: 'doc1', _class: 'test:class:Doc', space: 'space1' }]
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(nextFindAllResult))

      const result = await mw.findAll(ctx, 'test:class:Doc' as any, {})
      expect(result).toHaveLength(1)
    })
  })

  describe('$push with $each for batch member add', () => {
    it('should handle $push with $each for adding multiple members', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: {
          members: {
            $each: ['user2' as AccountUuid, 'user3' as AccountUuid],
            $position: 0
          } as any
        }
      })

      await mw.tx(ctx, [updateTx])

      // user2 should now see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      let passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('space1' as Ref<Space>)

      // user3 should also see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user3 = createAccount('user3')
      ctx.contextData = createSessionData(user3)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).toContain('space1' as Ref<Space>)
    })
  })

  describe('$pull with $in for batch member remove', () => {
    it('should handle $pull with $in for removing multiple members', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2', 'user3'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: {
          members: { $in: ['user2' as AccountUuid, 'user3' as AccountUuid] } as any
        }
      })

      await mw.tx(ctx, [updateTx])

      // user2 should no longer see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user2 = createAccount('user2')
      ctx.contextData = createSessionData(user2)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      let passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)

      // user3 should also not see space1
      ;(nextMiddleware.searchFulltext as jest.Mock).mockClear()
      const user3 = createAccount('user3')
      ctx.contextData = createSessionData(user3)
      await mw.searchFulltext(ctx, { query: 'test' }, { limit: 10 })
      passedSpaces = (nextMiddleware.searchFulltext as jest.Mock).mock.calls[0][1].spaces
      expect(passedSpaces).not.toContain('space1' as Ref<Space>)
    })
  })

  describe('owner permissions', () => {
    it('should allow owner to change private status', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      // Should not throw
      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should allow owner to change owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { owners: 'user2' as AccountUuid }
      })

      // Should not throw
      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should throw when non-owner tries to change private status', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change space privacy')
    })

    it('should throw when non-owner tries to change owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { owners: 'user2' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change space owners')
    })

    it('should throw when non-owner tries to push members in private space with owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      // user2 is a member but NOT an owner — must not be able to grant access to others
      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user3' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should throw when non-member tries to push members in private space with owners', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      // user3 is neither owner nor member — must not be able to push themselves
      const account = createAccount('user3')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user3' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should throw when non-owner tries to pull members in private space with owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2', 'user3'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: 'user3' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should allow non-owner member to pull themselves from private space (self-leave)', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: 'user2' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should allow non-owner member to pull themselves via $in (single self) from private space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: { $in: ['user2'] as AccountUuid[] } }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should throw when non-owner tries to pull self together with someone else', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2', 'user3'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { members: { $in: ['user2', 'user3'] as AccountUuid[] } }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should allow autoJoin self-push into private space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1'], { private: true, owners: ['user1'], autoJoin: true })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user2' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should NOT allow self-push into non-autoJoin private space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1'], { private: true, owners: ['user1'], autoJoin: false })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user2' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should throw when non-owner tries to replace members in private space with owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        members: ['user1' as AccountUuid, 'user2' as AccountUuid, 'user3' as AccountUuid]
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow('Only owners can change members of private spaces')
    })

    it('should allow owner to push members in private space', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user2' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should allow non-owner to push members in public space with owners', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      // Public space — members may freely change.
      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user3' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should throw when sole owner tries to remove themselves leaving owners empty', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const pullTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { owners: 'user1' as AccountUuid }
      })
      await expect(mw.tx(ctx, [pullTx])).rejects.toThrow('Space must keep at least one owner')

      const replaceTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        owners: []
      })
      await expect(mw.tx(ctx, [replaceTx])).rejects.toThrow('Space must keep at least one owner')
    })

    it('should allow owner to step down when another owner remains', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1', 'user2'] })
      ])
      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const pullTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $pull: { owners: 'user1' as AccountUuid }
      })
      await expect(mw.tx(ctx, [pullTx])).resolves.not.toThrow()
    })

    it('should throw when non-owner creates private space without being in owners', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Private Space',
          description: '',
          private: true,
          archived: false,
          members: ['user2' as AccountUuid],
          owners: ['user1' as AccountUuid] // user2 is not owner
        },
        'privateSpace' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).rejects.toThrow('Only owners can create private spaces')
    })

    it('should allow creator to create private space when they are in owners', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Private Space',
          description: '',
          private: true,
          archived: false,
          members: ['user1' as AccountUuid],
          owners: ['user1' as AccountUuid] // creator is owner
        },
        'privateSpace' as Ref<Space>
      )

      // Should not throw
      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('should allow AccountRole.Owner to bypass permission checks', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const adminAccount = createAccount('admin1', AccountRole.Owner)
      ctx.contextData = createSessionData(adminAccount)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true,
        $push: { owners: 'user2' as AccountUuid }
      })

      // Should not throw for admin
      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should skip permission checks for spaces without owners', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: false })])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      // Should not throw for spaces without owners
      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    // Intentional: public space creation is not gated by owners. Anyone can
    // create a public space and hand ownership to another account; the space
    // is visible to everyone regardless, so there is no privacy to protect.
    // Private-space spoofing is covered by the next test.
    it('should allow create of public space with foreign owners', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Delegated Space',
          description: '',
          private: false,
          archived: false,
          members: ['user1' as AccountUuid],
          owners: ['user2' as AccountUuid]
        },
        'delegatedSpace' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('should reject create when creator is not in owners (private space, non-empty owners)', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('attacker')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Trojan Space',
          description: '',
          private: true,
          archived: false,
          members: ['attacker' as AccountUuid],
          owners: ['victim' as AccountUuid]
        },
        'trojanSpace' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).rejects.toThrow(/owners/)
    })

    it('should allow create with empty owners (bootstrap)', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: 'Open Space',
          description: '',
          private: false,
          archived: false,
          members: ['user1' as AccountUuid],
          owners: []
        },
        'openSpace' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('should allow creating private space without owners when creator is member (DM)', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: '',
          description: '',
          private: true,
          archived: false,
          members: ['user1' as AccountUuid, 'user2' as AccountUuid]
        },
        'dmSpace' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('should reject creating private space without owners when creator is not member', async () => {
      const mw = await createMiddleware([])

      const account = createAccount('attacker')
      ctx.contextData = createSessionData(account)

      const createTx = txFactory.createTxCreateDoc(
        testSpaceClass,
        core.space.Space,
        {
          name: '',
          description: '',
          private: true,
          archived: false,
          members: ['user1' as AccountUuid, 'user2' as AccountUuid]
        },
        'dmSpace2' as Ref<Space>
      )

      await expect(mw.tx(ctx, [createTx])).rejects.toThrow(
        'Cannot create private space without being a member or owner'
      )
    })
  })

  describe('remove permissions', () => {
    it('should throw when non-owner tries to delete private space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)

      await expect(mw.tx(ctx, [removeTx])).rejects.toThrow('Only owners can delete private spaces')
    })

    it('should allow owner to delete private space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: true, owners: ['user1'] })
      ])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)

      await expect(mw.tx(ctx, [removeTx])).resolves.not.toThrow()
    })

    it('should allow anyone to delete public space', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1', 'user2'], { private: false, owners: ['user1'] })
      ])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)

      await expect(mw.tx(ctx, [removeTx])).resolves.not.toThrow()
    })
  })

  describe('private space without owners', () => {
    it('should throw when modifying private space without owners (non-admin)', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: false
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow(
        'Only admins can change private/owners on spaces without owners'
      )
    })

    it('should allow admin to modify private space without owners', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const account = createAccount('admin1', AccountRole.Admin)
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: false
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should skip permission checks for public spaces without owners', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: false })])

      const account = createAccount('user2')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        private: true
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should allow members to push members in private space without owners (DM scenario)', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1', 'user2'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { members: 'user3' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).resolves.not.toThrow()
    })

    it('should block owners change in private space without owners (non-admin)', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const updateTx = txFactory.createTxUpdateDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>, {
        $push: { owners: 'user1' as AccountUuid }
      })

      await expect(mw.tx(ctx, [updateTx])).rejects.toThrow(
        'Only admins can change private/owners on spaces without owners'
      )
    })

    it('should block delete of private space without owners (non-admin)', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true })])

      const account = createAccount('user1')
      ctx.contextData = createSessionData(account)

      const removeTx = txFactory.createTxRemoveDoc(testSpaceClass, core.space.Space, 'space1' as Ref<Space>)

      await expect(mw.tx(ctx, [removeTx])).rejects.toThrow('Only admins can delete private spaces without owners')
    })
  })

  // Regression: middleware no longer performs client-side space filtering in
  // findAll. It relies on the downstream DB adapter to honor security based on
  // `ctx.contextData.account`. These tests lock in the passthrough contract so
  // that any reintroduction of middleware-side filtering is intentional.
  describe('findAll - adapter passthrough contract', () => {
    it('should forward query to next middleware unchanged for regular users', async () => {
      const mw = await createMiddleware([
        createSpace('space1', ['user1'], { private: true, owners: ['user1'] }),
        createSpace('space2', ['user2'], { private: true, owners: ['user2'] })
      ])

      const user1 = createAccount('user1')
      ctx.contextData = createSessionData(user1)

      nextFindAllResult = [{ _id: 'doc1', _class: 'test:class:Doc', space: 'space2' }]
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(nextFindAllResult))

      const inputQuery = { space: 'space2' as Ref<Space> }
      await mw.findAll(ctx, 'test:class:Doc' as any, inputQuery)

      const call = (nextMiddleware.findAll as jest.Mock).mock.calls.at(-1)
      expect(call?.[2]).toEqual(inputQuery)
    })

    it('should not mutate options.allowedSpaces for regular users', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const user1 = createAccount('user1')
      ctx.contextData = createSessionData(user1)

      const opts = { limit: 10 }
      await mw.findAll(ctx, 'test:class:Doc' as any, {}, opts)

      const call = (nextMiddleware.findAll as jest.Mock).mock.calls.at(-1)
      // Adapter is responsible for security - middleware must not inject
      // allowedSpaces because downstream code has no guarantee it came from
      // the security layer vs. from the caller.
      expect(call?.[3]?.allowedSpaces).toBeUndefined()
    })

    it('should forward result from next middleware without client-side space filter', async () => {
      const mw = await createMiddleware([createSpace('space1', ['user1'], { private: true, owners: ['user1'] })])

      const user1 = createAccount('user1')
      ctx.contextData = createSessionData(user1)

      // Simulate an adapter that (correctly or not) returned a doc in a space
      // the user doesn't have access to. Middleware must trust the adapter.
      nextFindAllResult = [
        { _id: 'allowed', _class: 'test:class:Doc', space: 'space1' },
        { _id: 'leaked', _class: 'test:class:Doc', space: 'space2' }
      ]
      ;(nextMiddleware.findAll as jest.Mock).mockImplementation(async () => toFindResult(nextFindAllResult))

      const result = await mw.findAll(ctx, 'test:class:Doc' as any, {})
      // Middleware is no longer a defense-in-depth layer here; it passes
      // whatever the adapter returned. If this assertion ever changes, audit
      // every DbAdapter to confirm it applies space security.
      expect(result).toHaveLength(2)
    })
  })

  describe('write access into non-space objects', () => {
    const docTx = (space: string): TxCreateDoc<Doc> =>
      txFactory.createTxCreateDoc(core.class.Doc, space as Ref<Space>, {} as any, 'doc1' as Ref<Doc>)

    it('rejects a non-member write into a private space', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const outsider = createAccount('outsider')
      ctx.contextData = createSessionData(outsider)

      const createTx = docTx('private1')

      await expect(mw.tx(ctx, [createTx])).rejects.toThrow()
      expect(nextMiddleware.tx).not.toHaveBeenCalled()
    })

    it('allows a member to write into a private space they belong to', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const member = createAccount('user1')
      ctx.contextData = createSessionData(member)

      const createTx = docTx('private1')

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
      expect(nextMiddleware.tx).toHaveBeenCalledWith(ctx, [createTx])
    })

    it('allows a write into a public space regardless of membership', async () => {
      const mw = await createMiddleware([createSpace('public1', ['user1'], { private: false })])

      const outsider = createAccount('outsider')
      ctx.contextData = createSessionData(outsider)

      const createTx = docTx('public1')

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('allows a trigger-derived tx regardless of membership', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const outsider = createAccount('outsider')
      ctx.contextData = createSessionData(outsider)

      const createTx = docTx('private1')
      ;(createTx as any).space = core.space.DerivedTx

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('allows the system account to write into any space', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const system = createAccount(systemAccountUuid)
      ctx.contextData = createSessionData(system)

      const createTx = docTx('private1')

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    it('allows AccountRole.Admin to write into any space', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const admin = createAccount('admin1', AccountRole.Admin)
      ctx.contextData = createSessionData(admin)

      const createTx = docTx('private1')

      await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
    })

    // addSecurity only lets Owner skip the space filter for the Space domain itself (reading/
    // listing spaces); for regular documents in other spaces the membership check still applies.
    it('does NOT exempt AccountRole.Owner from the write-membership check outside the Space domain', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const owner = createAccount('owner1', AccountRole.Owner)
      ctx.contextData = createSessionData(owner)

      const createTx = docTx('private1')

      await expect(mw.tx(ctx, [createTx])).rejects.toThrow()
    })

    it('rejects a non-member write wrapped in TxApplyIf', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      const outsider = createAccount('outsider')
      ctx.contextData = createSessionData(outsider)

      const createTx = docTx('private1')
      const applyTx = txFactory.createTxApplyIf(core.space.Tx, undefined, [], [], [createTx], undefined)

      await expect(mw.tx(ctx, [applyTx])).rejects.toThrow()
      expect(nextMiddleware.tx).not.toHaveBeenCalled()
    })

    it('allows a member write wrapped in TxApplyIf', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      ctx.contextData = createSessionData(createAccount('user1'))

      const createTx = docTx('private1')
      const applyTx = txFactory.createTxApplyIf(core.space.Tx, undefined, [], [], [createTx], undefined)

      await expect(mw.tx(ctx, [applyTx])).resolves.not.toThrow()
      expect(nextMiddleware.tx).toHaveBeenCalledWith(ctx, [applyTx])
    })

    // Guests reach documents through Collaborator, not membership - GuestPermissionsMiddleware judges
    // them, so a membership-only check here would cut off QMS reviewers who are not space members.
    it('leaves guest roles to GuestPermissionsMiddleware', async () => {
      const mw = await createMiddleware([createSpace('private1', ['user1'], { private: true, owners: ['user1'] })])

      for (const role of [AccountRole.Guest, AccountRole.DocGuest, AccountRole.ReadOnlyGuest]) {
        ctx.contextData = createSessionData(createAccount('guest1', role))

        const createTx = docTx('private1')

        await expect(mw.tx(ctx, [createTx])).resolves.not.toThrow()
      }
    })
  })
})
