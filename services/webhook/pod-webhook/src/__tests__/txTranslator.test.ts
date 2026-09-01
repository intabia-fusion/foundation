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

jest.mock('../workspaceClient', () => ({ getSystemTransactorTarget: jest.fn() }))

/* eslint-disable import/first */
import chunter from '@hcengineering/chunter'
import core, { type Tx, type WorkspaceUuid } from '@hcengineering/core'
import document from '@hcengineering/document'
import setting, { type WebhookEventType } from '@hcengineering/setting'
import type { ConsumerMessage } from '@hcengineering/server-core'
import tracker from '@hcengineering/tracker'

import { domainRules, type DomainRule } from '../eventTable'
import {
  buildEventsForBatch,
  dispatch,
  resolveClassesForBatch,
  type ClassResolutionCache,
  type ObjectCache
} from '../txTranslator'
import type { WebhookEvent } from '../types'
import { getSystemTransactorTarget } from '../workspaceClient'
/* eslint-enable import/first */

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

let idCounter = 0
function nextTxId (): string {
  idCounter += 1
  return `tx${idCounter}`
}

function ws (workspace: string, tx: unknown): ConsumerMessage<Tx> {
  return { workspace: workspace as WorkspaceUuid, value: tx as Tx }
}

function createTx (
  objectClass: string,
  objectId: string,
  objectSpace: string,
  attributes: Record<string, unknown>,
  opts: { attachedToClass?: string, modifiedBy?: string } = {}
): unknown {
  return {
    _id: nextTxId(),
    _class: core.class.TxCreateDoc,
    space: core.space.Tx,
    objectId,
    objectClass,
    objectSpace,
    attributes,
    modifiedBy: opts.modifiedBy ?? 'actor-1',
    modifiedOn: Date.now(),
    ...(opts.attachedToClass !== undefined
      ? { attachedToClass: opts.attachedToClass, attachedTo: objectId, collection: 'x' }
      : {})
  }
}

function updateTx (
  objectClass: string,
  objectId: string,
  objectSpace: string,
  operations: Record<string, unknown>,
  opts: { modifiedBy?: string } = {}
): unknown {
  return {
    _id: nextTxId(),
    _class: core.class.TxUpdateDoc,
    space: core.space.Tx,
    objectId,
    objectClass,
    objectSpace,
    operations,
    modifiedBy: opts.modifiedBy ?? 'actor-1',
    modifiedOn: Date.now()
  }
}

function removeTx (
  objectClass: string,
  objectId: string,
  objectSpace: string,
  opts: { modifiedBy?: string } = {}
): unknown {
  return {
    _id: nextTxId(),
    _class: core.class.TxRemoveDoc,
    space: core.space.Tx,
    objectId,
    objectClass,
    objectSpace,
    modifiedBy: opts.modifiedBy ?? 'actor-1',
    modifiedOn: Date.now()
  }
}

function eventOf (
  translated: Array<{ workspace: WorkspaceUuid, event: WebhookEvent }>,
  objectId: string
): WebhookEvent | undefined {
  return translated.find((t) => t.event.data.id === objectId)?.event
}

describe('buildEventsForBatch - collapsing rules', () => {
  test('create then update collapses to one create event with the final state', () => {
    const cache: ObjectCache = new Map()
    const msgs = [
      ws(
        'ws1',
        createTx(tracker.class.Issue, 'issue1', 'space1', { title: 'Bug', status: 'todo', assignee: null, priority: 0 })
      ),
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'in-progress' }))
    ]

    const events = buildEventsForBatch(domainRules, cache, new Map(), msgs)

    expect(events).toHaveLength(1)
    expect(events[0].event.action).toBe('create')
    expect(events[0].event.type).toBe('issue.created')
    expect(events[0].event.data).toEqual({
      id: 'issue1',
      title: 'Bug',
      status: 'in-progress',
      assignee: null,
      priority: 0
    })
    expect(events[0].event.updatedFrom).toBeUndefined()
  })

  test('a create event reports the creator, not whoever edited it later in the same batch', () => {
    const cache: ObjectCache = new Map()
    const create = createTx(tracker.class.Issue, 'issue1', 'space1', {
      title: 'Bug',
      status: 'todo',
      assignee: null,
      priority: 0
    }) as any
    const update = updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'in-progress' }) as any
    update.modifiedBy = 'someone-else'

    const events = buildEventsForBatch(domainRules, cache, new Map(), [ws('ws1', create), ws('ws1', update)])

    expect(events[0].event.actor).toBe(create.modifiedBy)
  })

  test('a create seeds updatedFrom for a later batch even when the field is only watched by an update rule', () => {
    const cache: ObjectCache = new Map()
    buildEventsForBatch(domainRules, cache, new Map(), [
      ws(
        'ws1',
        createTx(tracker.class.Issue, 'issue1', 'space1', { title: 'Bug', status: 'todo', assignee: null, priority: 0 })
      )
    ])

    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done' }))
    ])

    expect(events[0].event.updatedFrom).toEqual({ status: 'todo' })
  })

  test('a create seeds the identifier, and a later update event carries it through the cache', () => {
    const cache: ObjectCache = new Map()
    buildEventsForBatch(domainRules, cache, new Map(), [
      ws(
        'ws1',
        createTx(tracker.class.Issue, 'issue1', 'space1', {
          title: 'Bug',
          status: 'todo',
          assignee: null,
          priority: 0,
          identifier: 'FUSIO-1'
        })
      )
    ])

    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done' }))
    ])

    expect(events[0].event.data).toEqual({ id: 'issue1', identifier: 'FUSIO-1', status: 'done' })
  })

  test('an update event omits identifier when this pod never cached the create', () => {
    const cache: ObjectCache = new Map()
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done' }))
    ])

    expect(events[0].event.data).toEqual({ id: 'issue1', status: 'done' })
  })

  test('several updates to the same field collapse to one update event, data from last, updatedFrom from before the first', () => {
    const cache: ObjectCache = new Map([['ws1:issue1', { status: 'todo' }]])
    const msgs = [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'in-progress' })),
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done' }))
    ]

    const events = buildEventsForBatch(domainRules, cache, new Map(), msgs)

    expect(events).toHaveLength(1)
    expect(events[0].event).toMatchObject({
      action: 'update',
      type: 'issue.status_changed',
      data: { id: 'issue1', status: 'done' },
      updatedFrom: { status: 'todo' }
    })
    expect(cache.get('ws1:issue1')).toEqual({ status: 'done' })
  })

  test('an update with no prior known value omits it from updatedFrom instead of guessing', () => {
    const cache: ObjectCache = new Map()
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done' }))
    ])

    expect(events[0].event.updatedFrom).toEqual({})
  })

  test('an update touching two different tracked fields emits two distinct events, not one', () => {
    const cache: ObjectCache = new Map()
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'done', assignee: 'person1' }))
    ])

    expect(events.map((e) => e.event.type).sort()).toEqual(['issue.assigned', 'issue.status_changed'])
  })

  test('update then remove collapses to one remove event, using a mapped remove rule', () => {
    // No class in the production table has a mapped remove event yet (see eventTable.ts) - this proves
    // the collapsing mechanism itself with a synthetic rule, independent of that.
    const rules: DomainRule[] = [
      ...domainRules,
      { kind: 'remove', objectClass: tracker.class.Issue, type: 'issue.removed' as WebhookEventType }
    ]
    const cache: ObjectCache = new Map([['ws1:issue1', { status: 'todo' }]])
    const msgs = [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { status: 'in-progress' })),
      ws('ws1', removeTx(tracker.class.Issue, 'issue1', 'space1'))
    ]

    const events = buildEventsForBatch(rules, cache, new Map(), msgs)

    expect(events).toHaveLength(1)
    expect(events[0].event).toMatchObject({
      action: 'remove',
      type: 'issue.removed',
      data: { id: 'issue1', status: 'todo' }
    })
    expect(cache.has('ws1:issue1')).toBe(false)
  })

  test('create then remove within the same batch also collapses to remove, not create', () => {
    const rules: DomainRule[] = [
      ...domainRules,
      { kind: 'remove', objectClass: tracker.class.Issue, type: 'issue.removed' as WebhookEventType }
    ]
    const cache: ObjectCache = new Map()
    const msgs = [
      ws(
        'ws1',
        createTx(tracker.class.Issue, 'issue1', 'space1', { title: 'x', status: 'todo', assignee: null, priority: 0 })
      ),
      ws('ws1', removeTx(tracker.class.Issue, 'issue1', 'space1'))
    ]

    const events = buildEventsForBatch(rules, cache, new Map(), msgs)

    expect(events).toHaveLength(1)
    expect(events[0].event.action).toBe('remove')
  })

  test('a remove with no rule mapped produces no event but still clears the cache', () => {
    const cache: ObjectCache = new Map([['ws1:issue1', { status: 'todo' }]])
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', removeTx(tracker.class.Issue, 'issue1', 'space1'))
    ])

    expect(events).toHaveLength(0)
    expect(cache.has('ws1:issue1')).toBe(false)
  })

  test('different objects are not collapsed, and events keep first-occurrence order within a space', () => {
    const cache: ObjectCache = new Map()
    const msgs = [
      ws('ws1', createTx(document.class.Document, 'doc-b', 'space1', { title: 'B' })),
      ws('ws1', createTx(document.class.Document, 'doc-a', 'space1', { title: 'A' })),
      ws(
        'ws1',
        createTx(tracker.class.Issue, 'issue1', 'space1', { title: 'C', status: 's', assignee: null, priority: 0 })
      )
    ]

    const events = buildEventsForBatch(domainRules, cache, new Map(), msgs)

    expect(events.map((e) => e.event.data.id)).toEqual(['doc-b', 'doc-a', 'issue1'])
  })

  test('a ChatMessage create on an Issue maps to issue.commented, on a Channel to message.posted', () => {
    const cache: ObjectCache = new Map()
    const msgs = [
      ws(
        'ws1',
        createTx(
          chunter.class.ChatMessage,
          'msg1',
          'space1',
          { message: 'hi' },
          { attachedToClass: tracker.class.Issue }
        )
      ),
      ws(
        'ws1',
        createTx(
          chunter.class.ChatMessage,
          'msg2',
          'space2',
          { message: 'yo' },
          { attachedToClass: chunter.class.Channel }
        )
      )
    ]

    const events = buildEventsForBatch(domainRules, cache, new Map(), msgs)

    expect(eventOf(events, 'msg1')?.type).toBe('issue.commented')
    expect(eventOf(events, 'msg2')?.type).toBe('message.posted')
  })

  test('a comment on a custom task type resolves through attachedToClass and still maps to issue.commented', () => {
    const custom = 'tracker:class:CustomTaskType' as any
    const classCache = new Map([[`ws1:${custom as string}`, tracker.class.Issue]])
    const msgs = [
      ws('ws1', createTx(chunter.class.ChatMessage, 'msg1', 'space1', { message: 'hi' }, { attachedToClass: custom }))
    ]

    const events = buildEventsForBatch(domainRules, new Map(), classCache, msgs)

    expect(eventOf(events, 'msg1')?.type).toBe('issue.commented')
  })

  test('a transaction whose class has no entry in the mapping table produces no event', () => {
    const cache: ObjectCache = new Map()
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', createTx('unmapped:class:Thing', 'x1', 'space1', { foo: 'bar' }))
    ])

    expect(events).toHaveLength(0)
  })

  test('an update to an untracked field on a tracked class produces no event', () => {
    const cache: ObjectCache = new Map()
    const events = buildEventsForBatch(domainRules, cache, new Map(), [
      ws('ws1', updateTx(tracker.class.Issue, 'issue1', 'space1', { description: 'x' }))
    ])

    expect(events).toHaveLength(0)
  })

  test('a DerivedTx (trigger side-effect, not a user action) is ignored', () => {
    const cache: ObjectCache = new Map()
    const tx = createTx(tracker.class.Issue, 'issue1', 'space1', {
      title: 'x',
      status: 's',
      assignee: null,
      priority: 0
    }) as any
    tx.space = core.space.DerivedTx

    const events = buildEventsForBatch(domainRules, cache, new Map(), [ws('ws1', tx)])

    expect(events).toHaveLength(0)
  })
})

describe('dispatch', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  function baseEvent (overrides: Partial<WebhookEvent> = {}): WebhookEvent {
    return {
      action: 'create',
      type: 'issue.created',
      actor: 'actor-1' as any,
      data: { id: 'issue1' },
      organizationId: 'ws1' as any,
      ...overrides
    }
  }

  function baseEndpoint (overrides: Record<string, unknown> = {}): any {
    return { _id: 'ep1', events: ['issue.created'], enabled: true, ...overrides }
  }

  // dispatch loads endpoints and the workspace's private spaces through the same findAll.
  function mockRest (endpoints: any[], privateSpaces: any[] = []): jest.Mock {
    const findAll = jest
      .fn()
      .mockImplementation(async (_class: any) => (_class === setting.class.WebhookEndpoint ? endpoints : privateSpaces))
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({ rest: { findAll } })
    return findAll
  }

  function incoming (space: string = 'space1', overrides: Partial<WebhookEvent> = {}): any {
    return { space, event: baseEvent(overrides) }
  }

  test('sends a delivery message only to an enabled endpoint subscribed to the event type', async () => {
    const findAll = mockRest([baseEndpoint()])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming()])

    expect(findAll).toHaveBeenCalledWith(setting.class.WebhookEndpoint, { enabled: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [, workspace, messages] = send.mock.calls[0]
    expect(workspace).toBe('ws1')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ endpointId: 'ep1', workspace: 'ws1', attempt: 0 })
  })

  test('a transactor outage throws so the batch is replayed instead of dropping events', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockRejectedValue(new Error('transactor down'))
    const send = jest.fn()

    await expect(dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming()])).rejects.toThrow(
      'transactor down'
    )
    expect(send).not.toHaveBeenCalled()
  })

  test('endpoints are fetched once per workspace and reused from cache on the next batch', async () => {
    const findAll = mockRest([baseEndpoint()])
    const send = jest.fn().mockResolvedValue(undefined)
    const endpointCache = new Map()

    await dispatch(newCtx(), {} as any, { send } as any, endpointCache, 'ws1' as any, [incoming()])
    await dispatch(newCtx(), {} as any, { send } as any, endpointCache, 'ws1' as any, [incoming()])

    // Endpoints and private spaces, loaded together and cached together.
    expect(findAll).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('skips an endpoint not subscribed to the event type', async () => {
    mockRest([baseEndpoint({ events: ['document.created'] })])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming()])

    expect(send).not.toHaveBeenCalled()
  })

  test('an endpoint with no space whitelist never sees a private space', async () => {
    mockRest([baseEndpoint()], [{ _id: 'secret' }])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming('secret')])

    expect(send).not.toHaveBeenCalled()
  })

  test('a private space is delivered once the endpoint names it explicitly', async () => {
    mockRest([baseEndpoint({ spaces: ['secret'] })], [{ _id: 'secret' }])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming('secret')])

    expect(send).toHaveBeenCalledTimes(1)
  })

  test('a whitelist excludes every space it does not list, private or not', async () => {
    mockRest([baseEndpoint({ spaces: ['space1'] })])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming('space2')])

    expect(send).not.toHaveBeenCalled()
  })

  test('one event with two matching endpoints produces two delivery messages', async () => {
    mockRest([baseEndpoint({ _id: 'ep1' }), baseEndpoint({ _id: 'ep2' })])
    const send = jest.fn().mockResolvedValue(undefined)

    await dispatch(newCtx(), {} as any, { send } as any, new Map(), 'ws1' as any, [incoming()])

    const [, , messages] = send.mock.calls[0]
    expect(messages.map((m: any) => m.endpointId).sort()).toEqual(['ep1', 'ep2'])
  })
})

describe('resolveClassesForBatch - hierarchy-derived classes', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  test('a batch of only known classes never touches the transactor', async () => {
    const findAll = jest.fn()
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({ rest: { findAll } })
    const msgs = [ws('ws1', createTx(tracker.class.Issue, 'issue1', 'space1', { title: 'Bug' }))]

    await resolveClassesForBatch(newCtx(), {} as any, new Map(), domainRules, msgs)

    expect(getSystemTransactorTarget).not.toHaveBeenCalled()
    expect(findAll).not.toHaveBeenCalled()
  })

  test('a class derived from tracker.class.Issue is treated as one, producing issue.created', async () => {
    const findAll = jest.fn().mockResolvedValue([{ _id: 'custom:issueType', extends: tracker.class.Issue }])
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({ rest: { findAll } })
    const classCache: ClassResolutionCache = new Map()
    const cache: ObjectCache = new Map()
    const msgs = [
      ws(
        'ws1',
        createTx('custom:issueType', 'issue1', 'space1', { title: 'Bug', status: 'todo', assignee: null, priority: 0 })
      )
    ]

    await resolveClassesForBatch(newCtx(), {} as any, classCache, domainRules, msgs)
    const events = buildEventsForBatch(domainRules, cache, classCache, msgs)

    expect(events).toHaveLength(1)
    expect(events[0].event.type).toBe('issue.created')
  })

  test('a class outside the rule hierarchy produces nothing and is resolved only once', async () => {
    const findAll = jest.fn().mockResolvedValue([{ _id: 'custom:otherType', extends: core.class.Doc }])
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({ rest: { findAll } })
    const classCache: ClassResolutionCache = new Map()
    const cache: ObjectCache = new Map()
    const msg = ws('ws1', createTx('custom:otherType', 'x1', 'space1', { foo: 'bar' }))

    await resolveClassesForBatch(newCtx(), {} as any, classCache, domainRules, [msg])
    expect(buildEventsForBatch(domainRules, cache, classCache, [msg])).toHaveLength(0)

    // Second batch, same unmapped class - must not hit the transactor again.
    await resolveClassesForBatch(newCtx(), {} as any, classCache, domainRules, [msg])
    expect(buildEventsForBatch(domainRules, cache, classCache, [msg])).toHaveLength(0)
    expect(findAll).toHaveBeenCalledTimes(1)
  })

  test('a transactor outage during resolution throws instead of silently dropping events', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockRejectedValue(new Error('transactor down'))
    const classCache: ClassResolutionCache = new Map()
    const msg = ws('ws1', createTx('custom:issueType', 'issue1', 'space1', { title: 'Bug' }))

    await expect(resolveClassesForBatch(newCtx(), {} as any, classCache, domainRules, [msg])).rejects.toThrow(
      'transactor down'
    )
  })
})
