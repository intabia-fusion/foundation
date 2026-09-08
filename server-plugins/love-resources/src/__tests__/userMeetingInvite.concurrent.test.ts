/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
*/

// Concurrency / collateral-damage tests for OnUserMeetingInvite.
// These exercise the (kind, from, to) `findAll` patterns inside the
// trigger to surface scenarios where one in-flight call's lifecycle
// accidentally wipes another in-flight call's invites.
//
// Scenario we want to catch:
//   * caller has two outgoing invite-requests to the same recipient
//     (e.g. user mashed the call button, or two concurrent flows from
//     the same client),
//   * the FIRST request is removed (cancelled or auto-cleaned),
//   * the trigger MUST NOT remove the OTHER pending invite-response.
//
// Today the trigger blindly removes every matching invite-response on
// any `TxRemoveDoc invite-request` for the same (from, to) pair —
// this test makes that explicit and fails until the lookup is narrowed.

import core, {
  type AccountUuid,
  type Class,
  type Doc,
  generateId,
  type MeasureContext,
  type PersonId,
  type Ref,
  type Space,
  toFindResult,
  type Tx,
  TxFactory,
  type TxRemoveDoc
} from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'
import contact, { type Person, type PersonSpace } from '@hcengineering/contact'
import love, { type UserMeetingInvite } from '@hcengineering/love'
import { OnUserMeetingInvite } from '../index'

jest.mock('@hcengineering/server-contact', () => ({
  getAccountBySocialId: jest.fn(async () => null),
  getSocialStrings: jest.fn(async () => [])
}))

const callerPersonRef = 'person:caller' as Ref<Person>
const recipientPersonRef = 'person:recipient' as Ref<Person>
const callerAccount = 'account:caller' as AccountUuid
const recipientAccount = 'account:recipient' as AccountUuid

const callerPersonSpaceRef = 'space:caller' as Ref<PersonSpace>
const recipientPersonSpaceRef = 'space:recipient' as Ref<PersonSpace>

function createPerson (id: Ref<Person>, uuid?: AccountUuid): Person {
  return {
    _id: id,
    _class: contact.class.Person,
    space: contact.space.Contacts,
    name: 'Test,Person',
    city: '',
    avatarType: 'COLOR',
    personUuid: uuid,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } as unknown as Person
}

function createInvite (overrides: Partial<UserMeetingInvite> & { _id: Ref<UserMeetingInvite> }): UserMeetingInvite {
  return {
    _class: love.class.UserMeetingInvite,
    kind: 'invite-request',
    from: callerPersonRef,
    to: recipientPersonRef,
    status: 'pending',
    modifiedOn: Date.now(),
    modifiedBy: core.account.System,
    space: core.space.Space,
    ...overrides
  } as unknown as UserMeetingInvite
}

interface Fixtures {
  invites: UserMeetingInvite[]
  removedMap: Map<Ref<Doc>, Doc>
}

function findAllFor (fixtures: Fixtures) {
  return (_class: Ref<Class<Doc>>, query: any): Doc[] => {
    if (_class === love.class.UserMeetingInvite) {
      let inv = fixtures.invites
      if (query?.kind !== undefined) inv = inv.filter((it) => it.kind === query.kind)
      if (query?.from !== undefined) inv = inv.filter((it) => it.from === query.from)
      if (query?.to !== undefined) inv = inv.filter((it) => it.to === query.to)
      if (query?.meeting !== undefined) inv = inv.filter((it) => it.meeting === query.meeting)
      if (query?.room !== undefined) inv = inv.filter((it) => it.room === query.room)
      if (query?._id !== undefined) inv = inv.filter((it) => it._id === query._id)
      return inv
    }
    if (_class === contact.class.Person) {
      return [createPerson(callerPersonRef, callerAccount), createPerson(recipientPersonRef, recipientAccount)] as Doc[]
    }
    if (_class === love.class.ParticipantInfo) return []
    if (_class === contact.mixin.Employee) return []
    return []
  }
}

function createMockControl (fixtures: Fixtures): TriggerControl {
  return {
    ctx: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      newChild: jest.fn().mockReturnThis(),
      contextData: { broadcast: { targets: {} } }
    } as unknown as MeasureContext,
    workspace: { url: 'test-ws', uuid: 'test-ws-uuid', dataId: 'test-data', accountsUrl: '' } as any,
    branding: null,
    findAll: jest.fn(async (_ctx: any, _class: Ref<Class<Doc>>, query: any) => {
      return toFindResult(findAllFor(fixtures)(_class, query))
    }),
    txFactory: new TxFactory(core.account.System, true),
    hierarchy: {
      isDerived: (_class: Ref<Class<Doc>>, base: Ref<Class<Doc>>) => _class === base,
      hasMixin: () => false,
      as: (doc: Doc) => doc
    } as any,
    modelDb: {} as any,
    removedMap: fixtures.removedMap,
    userStatusMap: new Map(),
    cache: new Map(),
    contextCache: new Map(),
    withScope: async <T>(_scope: string, fn: () => Promise<T>) => await fn(),
    txes: [],
    apply: jest.fn().mockResolvedValue({}),
    queryFind: jest.fn().mockResolvedValue([]),
    storageAdapter: {} as any,
    serviceAdaptersManager: {} as any,
    lowLevel: {} as any,
    domainRequest: jest.fn().mockResolvedValue({})
  } as unknown as TriggerControl
}

function buildRemoveInviteRequestTx (id: Ref<UserMeetingInvite>, space: Ref<Space>): TxRemoveDoc<UserMeetingInvite> {
  return {
    _id: generateId(),
    _class: core.class.TxRemoveDoc,
    space: core.space.DerivedTx,
    objectId: id,
    objectClass: love.class.UserMeetingInvite,
    objectSpace: space,
    modifiedOn: Date.now(),
    modifiedBy: 'caller-social-id' as PersonId,
    createdBy: 'caller-social-id' as PersonId
  } satisfies TxRemoveDoc<UserMeetingInvite>
}

function findRemoves (txes: Tx[], cls: Ref<Class<Doc>>): Array<TxRemoveDoc<Doc>> {
  return txes.filter(
    (tx) => tx._class === core.class.TxRemoveDoc && (tx as TxRemoveDoc<Doc>).objectClass === cls
  ) as Array<TxRemoveDoc<Doc>>
}

describe('OnUserMeetingInvite - concurrent invites from the same pair', () => {
  /**
   * Two parallel invite-request entries from the same caller to the same
   * recipient. Cancelling the first one should only remove the matching
   * invite-response, not every invite-response for the (from, to) pair.
   *
   * Today the trigger uses `findAll({ kind: 'invite-response', from, to })`
   * and TxRemoveDoc-broadcasts every result — collateral damage that
   * silently wipes the user's concurrent in-flight invite.
   */
  it('removing one invite-request must not remove the OTHER invite-response for the same pair', async () => {
    // Two parallel calls between the same pair MUST carry distinct meeting
    // refs in the new model so the trigger can tell them apart.
    const meetingA = 'meeting:A' as unknown as UserMeetingInvite['meeting']
    const meetingB = 'meeting:B' as unknown as UserMeetingInvite['meeting']
    const req1: UserMeetingInvite = createInvite({
      _id: 'invite:req-1' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      meeting: meetingA,
      space: callerPersonSpaceRef
    })
    const req2: UserMeetingInvite = createInvite({
      _id: 'invite:req-2' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      meeting: meetingB,
      space: callerPersonSpaceRef
    })
    const resp1: UserMeetingInvite = createInvite({
      _id: 'invite:resp-1' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      meeting: meetingA,
      space: recipientPersonSpaceRef
    })
    const resp2: UserMeetingInvite = createInvite({
      _id: 'invite:resp-2' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      meeting: meetingB,
      space: recipientPersonSpaceRef
    })

    // sourceDoc lookup happens via findAll _id; we simulate the
    // "request was just removed" by serving it from `removedMap` and not
    // from `invites`. This mirrors the real trigger pipeline where the
    // TxRemoveDoc fires AFTER the doc is gone from storage.
    const removedMap = new Map<Ref<Doc>, Doc>([[req1._id, req1]])
    const fixtures: Fixtures = {
      // req1 removed from storage; req2/resp1/resp2 still present.
      invites: [req2, resp1, resp2],
      removedMap
    }
    const control = createMockControl(fixtures)
    const tx = buildRemoveInviteRequestTx(req1._id, callerPersonSpaceRef)

    const result = await OnUserMeetingInvite([tx], control)

    // Cancellation of req1 should remove ONLY the invite-response that
    // corresponds to req1. resp2 belongs to a different in-flight call
    // and must stay.
    const removes = findRemoves(result, love.class.UserMeetingInvite)
    const removedIds = new Set(removes.map((r) => r.objectId))
    expect(removedIds.has(resp2._id)).toBe(false)
  })
})
