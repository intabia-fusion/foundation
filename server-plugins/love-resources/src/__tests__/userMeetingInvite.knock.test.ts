/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
*/

// Knock fan-out (Scenario Б): creating an invite-request with `room` set
// must produce one invite-response per meeting owner. Accept by one owner
// drops sibling responses and pushes the knocker into the meeting members.

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
  TxFactory,
  type TxCreateDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'
import contact, { type Person, type PersonSpace } from '@hcengineering/contact'
import love, { MeetingStatus, type MeetingMinutes, type Room, type UserMeetingInvite } from '@hcengineering/love'
import { OnUserMeetingInvite } from '../index'

jest.mock('@hcengineering/server-contact', () => ({
  getAccountBySocialId: jest.fn(async () => 'account:owner1'),
  getSocialStrings: jest.fn(async () => [])
}))

const knocker = 'person:knocker' as Ref<Person>
const owner1 = 'person:owner1' as Ref<Person>
const owner2 = 'person:owner2' as Ref<Person>
const owner1Account = 'account:owner1' as AccountUuid
const owner2Account = 'account:owner2' as AccountUuid
const knockerAccount = 'account:knocker' as AccountUuid
const room = 'room:1' as Ref<Room>
const meetingId = 'meeting:1' as Ref<MeetingMinutes>

function person (id: Ref<Person>, account: AccountUuid): Person {
  return {
    _id: id,
    _class: contact.class.Person,
    space: contact.space.Contacts,
    name: 'Test,Person',
    city: '',
    avatarType: 'COLOR',
    personUuid: account,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } as unknown as Person
}

function personSpace (id: string, p: Ref<Person>): PersonSpace {
  return {
    _id: id as Ref<PersonSpace>,
    _class: contact.class.PersonSpace,
    space: core.space.Workspace,
    person: p,
    members: [],
    private: true,
    archived: false,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } as unknown as PersonSpace
}

function meetingDoc (overrides: Partial<MeetingMinutes> = {}): MeetingMinutes {
  return {
    _id: meetingId,
    _class: love.class.MeetingMinutes,
    space: meetingId as unknown as Ref<Space>,
    name: 'private',
    description: '',
    private: true,
    archived: false,
    members: [owner1Account],
    owners: [owner1Account, owner2Account],
    roomId: room,
    status: MeetingStatus.Active,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System,
    ...(overrides as any)
  } as unknown as MeetingMinutes
}

function invite (
  overrides: Partial<UserMeetingInvite> & { _id: Ref<UserMeetingInvite>, kind: 'invite-request' | 'invite-response' }
): UserMeetingInvite {
  return {
    _class: love.class.UserMeetingInvite,
    from: knocker,
    to: knocker,
    status: 'pending',
    modifiedOn: Date.now(),
    modifiedBy: core.account.System,
    space: core.space.Space,
    ...overrides
  } as unknown as UserMeetingInvite
}

interface Fixtures {
  invites: UserMeetingInvite[]
  meetings: MeetingMinutes[]
  spaces: PersonSpace[]
  removedMap: Map<Ref<Doc>, Doc>
}

function findAllFor (fixtures: Fixtures) {
  return (_class: Ref<Class<Doc>>, query: any): Doc[] => {
    if (_class === love.class.UserMeetingInvite) {
      let inv = fixtures.invites
      if (query?.kind !== undefined) inv = inv.filter((it) => it.kind === query.kind)
      if (query?.from !== undefined) inv = inv.filter((it) => it.from === query.from)
      if (query?.to !== undefined) inv = inv.filter((it) => it.to === query.to)
      if (query?.status !== undefined) inv = inv.filter((it) => it.status === query.status)
      if (query?.meeting !== undefined) inv = inv.filter((it) => it.meeting === query.meeting)
      if (query?.room !== undefined) inv = inv.filter((it) => it.room === query.room)
      if (query?._id !== undefined) inv = inv.filter((it) => it._id === query._id)
      return inv as Doc[]
    }
    if (_class === love.class.MeetingMinutes) {
      let m = fixtures.meetings
      if (query?._id !== undefined) m = m.filter((it) => it._id === query._id)
      if (query?.roomId !== undefined) m = m.filter((it) => it.roomId === query.roomId)
      if (query?.private !== undefined) m = m.filter((it) => it.private === query.private)
      return m as Doc[]
    }
    if (_class === contact.class.PersonSpace) {
      let s = fixtures.spaces
      if (query?.person !== undefined) s = s.filter((it) => it.person === query.person)
      return s as Doc[]
    }
    if (_class === contact.class.Person) {
      const all: Person[] = [
        person(knocker, knockerAccount),
        person(owner1, owner1Account),
        person(owner2, owner2Account)
      ]
      if (query?._id !== undefined) return all.filter((p) => p._id === query._id) as Doc[]
      if (query?.personUuid !== undefined) return all.filter((p) => p.personUuid === query.personUuid) as Doc[]
      return all as Doc[]
    }
    if (_class === contact.mixin.Employee) return []
    return []
  }
}

function createControl (fixtures: Fixtures): TriggerControl {
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
    hierarchy: { isDerived: () => false, hasMixin: () => false, as: (d: Doc) => d } as any,
    modelDb: {} as any,
    removedMap: fixtures.removedMap,
    userStatusMap: new Map(),
    cache: new Map(),
    contextCache: new Map(),
    withScope: async <T>(_s: string, fn: () => Promise<T>) => await fn(),
    txes: [],
    apply: jest.fn().mockResolvedValue({}),
    queryFind: jest.fn().mockResolvedValue([]),
    storageAdapter: {} as any,
    serviceAdaptersManager: {} as any,
    lowLevel: {} as any,
    domainRequest: jest.fn().mockResolvedValue({})
  } as unknown as TriggerControl
}

function buildCreateInviteRequestTx (req: UserMeetingInvite): TxCreateDoc<UserMeetingInvite> {
  return {
    _id: generateId(),
    _class: core.class.TxCreateDoc,
    space: core.space.DerivedTx,
    objectId: req._id,
    objectClass: love.class.UserMeetingInvite,
    objectSpace: req.space,
    attributes: { ...(req as any) },
    modifiedOn: Date.now(),
    modifiedBy: 'knocker-social-id' as PersonId,
    createdBy: 'knocker-social-id' as PersonId
  } satisfies TxCreateDoc<UserMeetingInvite>
}

function buildUpdateResponseTx (
  resp: UserMeetingInvite,
  status: 'accepted' | 'declined'
): TxUpdateDoc<UserMeetingInvite> {
  return {
    _id: generateId(),
    _class: core.class.TxUpdateDoc,
    space: core.space.DerivedTx,
    objectId: resp._id,
    objectClass: love.class.UserMeetingInvite,
    objectSpace: resp.space,
    operations: { status } as any,
    modifiedOn: Date.now(),
    modifiedBy: 'owner1-social-id' as PersonId,
    createdBy: 'owner1-social-id' as PersonId,
    retrieve: false
  } satisfies TxUpdateDoc<UserMeetingInvite>
}

describe('OnUserMeetingInvite - knock fan-out (Scenario Б)', () => {
  it('emits one invite-response per owner of the private meeting in the room', async () => {
    const fixtures: Fixtures = {
      invites: [],
      meetings: [meetingDoc()],
      spaces: [personSpace('space:owner1', owner1), personSpace('space:owner2', owner2)],
      removedMap: new Map()
    }
    const req = invite({
      _id: 'invite:req' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      room,
      space: 'space:knocker' as Ref<Space>
    })

    const control = createControl(fixtures)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    const responseCreates = result.filter(
      (t) =>
        t._class === core.class.TxCreateDoc &&
        (t as TxCreateDoc<UserMeetingInvite>).objectClass === love.class.UserMeetingInvite
    ) as Array<TxCreateDoc<UserMeetingInvite>>

    expect(responseCreates.length).toBe(2)
    const recipients = new Set(responseCreates.map((c) => c.attributes.to))
    expect(recipients.has(owner1)).toBe(true)
    expect(recipients.has(owner2)).toBe(true)
    for (const c of responseCreates) {
      expect(c.attributes.room).toBe(room)
      expect(c.attributes.meeting).toBe(meetingId)
    }
  })

  it('accept by an owner removes sibling invite-responses and pushes the knocker into members', async () => {
    const resp1 = invite({
      _id: 'invite:resp1' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner1,
      room,
      meeting: meetingId,
      space: 'space:owner1' as Ref<Space>
    })
    const resp2 = invite({
      _id: 'invite:resp2' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner2,
      room,
      meeting: meetingId,
      space: 'space:owner2' as Ref<Space>
    })
    const req = invite({
      _id: 'invite:req' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      from: knocker,
      to: knocker,
      room,
      space: 'space:knocker' as Ref<Space>
    })
    const fixtures: Fixtures = {
      invites: [resp1, resp2, req],
      meetings: [meetingDoc()],
      spaces: [personSpace('space:owner1', owner1), personSpace('space:owner2', owner2)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    const result = await OnUserMeetingInvite([buildUpdateResponseTx(resp1, 'accepted')], control)

    const removes = result.filter((t) => t._class === core.class.TxRemoveDoc) as unknown as Array<{
      objectId: Ref<Doc>
    }>
    const removedIds = new Set(removes.map((r) => r.objectId))
    expect(removedIds.has(resp1._id)).toBe(true)
    expect(removedIds.has(resp2._id)).toBe(true)

    const updates = result.filter(
      (t) => t._class === core.class.TxUpdateDoc && (t as TxUpdateDoc<MeetingMinutes>).objectId === meetingId
    ) as Array<TxUpdateDoc<MeetingMinutes>>
    expect(updates.some((u) => (u.operations as any).$push?.members === knockerAccount)).toBe(true)

    const requestSync = result.find(
      (t) => t._class === core.class.TxUpdateDoc && (t as TxUpdateDoc<UserMeetingInvite>).objectId === req._id
    ) as TxUpdateDoc<UserMeetingInvite> | undefined
    expect(requestSync?.operations.status).toBe('accepted')
    expect(requestSync?.operations.meeting).toBe(meetingId)
  })

  it('decline by one owner removes only that response; request stays pending', async () => {
    const resp1 = invite({
      _id: 'invite:resp1' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner1,
      room,
      meeting: meetingId,
      space: 'space:owner1' as Ref<Space>
    })
    const resp2 = invite({
      _id: 'invite:resp2' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner2,
      room,
      meeting: meetingId,
      space: 'space:owner2' as Ref<Space>
    })
    const req = invite({
      _id: 'invite:req' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      from: knocker,
      to: knocker,
      room,
      space: 'space:knocker' as Ref<Space>
    })
    const fixtures: Fixtures = {
      invites: [resp1, resp2, req],
      meetings: [meetingDoc()],
      spaces: [personSpace('space:owner1', owner1), personSpace('space:owner2', owner2)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    const result = await OnUserMeetingInvite([buildUpdateResponseTx(resp1, 'declined')], control)

    const removes = result.filter((t) => t._class === core.class.TxRemoveDoc) as unknown as Array<{
      objectId: Ref<Doc>
    }>
    const removedIds = new Set(removes.map((r) => r.objectId))
    expect(removedIds.has(resp1._id)).toBe(true)
    expect(removedIds.has(resp2._id)).toBe(false)
    // Request must not be flipped to declined while resp2 is still pending.
    const requestSync = result.find(
      (t) => t._class === core.class.TxUpdateDoc && (t as TxUpdateDoc<UserMeetingInvite>).objectId === req._id
    ) as TxUpdateDoc<UserMeetingInvite> | undefined
    expect(requestSync?.operations.status).toBeUndefined()
  })

  it('does not stack a second chip when the same person knocks into the same room again', async () => {
    const stale = invite({
      _id: 'invite:resp-stale' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner1,
      room,
      meeting: meetingId,
      space: 'space:owner1' as Ref<Space>
    })
    const fixtures: Fixtures = {
      invites: [stale],
      meetings: [meetingDoc({ owners: [owner1Account] })],
      spaces: [personSpace('space:owner1', owner1)],
      removedMap: new Map()
    }
    const req = invite({
      _id: 'invite:req2' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      room,
      space: 'space:knocker' as Ref<Space>
    })

    const control = createControl(fixtures)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    const responseCreates = result.filter(
      (t) =>
        t._class === core.class.TxCreateDoc &&
        (t as TxCreateDoc<UserMeetingInvite>).objectClass === love.class.UserMeetingInvite
    )
    expect(responseCreates.length).toBe(0)
  })

  it('still knocks into a second room of the same owner', async () => {
    const otherRoom = 'room:2' as Ref<Room>
    const stale = invite({
      _id: 'invite:resp-stale' as Ref<UserMeetingInvite>,
      kind: 'invite-response',
      from: knocker,
      to: owner1,
      room,
      meeting: meetingId,
      space: 'space:owner1' as Ref<Space>
    })
    const otherMeeting = meetingDoc({
      _id: 'meeting:2' as Ref<MeetingMinutes>,
      roomId: otherRoom,
      owners: [owner1Account]
    })
    const fixtures: Fixtures = {
      invites: [stale],
      meetings: [meetingDoc({ owners: [owner1Account] }), otherMeeting],
      spaces: [personSpace('space:owner1', owner1)],
      removedMap: new Map()
    }
    const req = invite({
      _id: 'invite:req3' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      room: otherRoom,
      space: 'space:knocker' as Ref<Space>
    })

    const control = createControl(fixtures)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    const responseCreates = result.filter(
      (t) =>
        t._class === core.class.TxCreateDoc &&
        (t as TxCreateDoc<UserMeetingInvite>).objectClass === love.class.UserMeetingInvite
    ) as Array<TxCreateDoc<UserMeetingInvite>>
    expect(responseCreates.length).toBe(1)
    expect(responseCreates[0].attributes.room).toBe(otherRoom)
  })
})

void contact
