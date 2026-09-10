/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
*/

// Scenario A invite into an EXISTING private meeting: the owner-caller's
// invite-request must grow the meeting members with the recipient up-front,
// otherwise the recipient never sees the private meeting space and the join
// times out with "MeetingMinutes not found after all retries".

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
  getAccountBySocialId: jest.fn(async () => 'account:caller'),
  getSocialStrings: jest.fn(async () => [])
}))

const caller = 'person:caller' as Ref<Person>
const recipient = 'person:recipient' as Ref<Person>
const stranger = 'person:stranger' as Ref<Person>
const callerAccount = 'account:caller' as AccountUuid
const recipientAccount = 'account:recipient' as AccountUuid
const room = 'room:1' as Ref<Room>
const meetingId = 'meeting:1' as Ref<MeetingMinutes>

function person (id: Ref<Person>, account: AccountUuid): Person {
  return {
    _id: id,
    _class: contact.class.Person,
    space: contact.space.Contacts,
    name: 'Test,Person',
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
    space: meetingId,
    name: 'private',
    description: '',
    private: true,
    archived: false,
    members: [callerAccount],
    owners: [callerAccount],
    roomId: room,
    status: MeetingStatus.Active,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System,
    ...(overrides as any)
  }
}

interface Fixtures {
  meetings: MeetingMinutes[]
  spaces: PersonSpace[]
  removedMap: Map<Ref<Doc>, Doc>
}

function findAllFor (fixtures: Fixtures) {
  return (_class: Ref<Class<Doc>>, query: any): Doc[] => {
    if (_class === love.class.MeetingMinutes) {
      let m = fixtures.meetings
      if (query?._id !== undefined) m = m.filter((it) => it._id === query._id)
      return m
    }
    if (_class === contact.class.PersonSpace) {
      let s = fixtures.spaces
      if (query?.person !== undefined) s = s.filter((it) => it.person === query.person)
      return s
    }
    if (_class === contact.class.Person) {
      const all: Person[] = [
        person(caller, callerAccount),
        person(recipient, recipientAccount),
        person(stranger, 'account:stranger' as AccountUuid)
      ]
      if (query?._id !== undefined) return all.filter((p) => p._id === query._id)
      if (query?.personUuid !== undefined) return all.filter((p) => p.personUuid === query.personUuid)
      return all
    }
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
    modifiedBy: 'caller-social-id' as PersonId,
    createdBy: 'caller-social-id' as PersonId
  } satisfies TxCreateDoc<UserMeetingInvite>
}

function inviteRequest (from: Ref<Person>, to: Ref<Person>, meeting: Ref<MeetingMinutes>): UserMeetingInvite {
  return {
    _id: 'invite:req' as Ref<UserMeetingInvite>,
    _class: love.class.UserMeetingInvite,
    kind: 'invite-request',
    from,
    to,
    meeting,
    status: 'pending',
    space: 'space:caller' as Ref<Space>,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } as unknown as UserMeetingInvite
}

function memberPushUpdates (result: Doc[]): Array<TxUpdateDoc<MeetingMinutes>> {
  return result.filter(
    (t) => t._class === core.class.TxUpdateDoc && (t as TxUpdateDoc<MeetingMinutes>).objectId === meetingId
  ) as Array<TxUpdateDoc<MeetingMinutes>>
}

describe('OnUserMeetingInvite - Scenario A invite into private meeting', () => {
  it('pushes the recipient into the private meeting members when the owner invites', async () => {
    const fixtures: Fixtures = {
      meetings: [meetingDoc()],
      spaces: [personSpace('space:recipient', recipient)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    const req = inviteRequest(caller, recipient, meetingId)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    const pushes = memberPushUpdates(result)
    expect(pushes.some((u) => (u.operations as any).$push?.members === recipientAccount)).toBe(true)

    // Recipient still gets their invite-response.
    const responseCreates = result.filter(
      (t) =>
        t._class === core.class.TxCreateDoc &&
        (t as TxCreateDoc<UserMeetingInvite>).objectClass === love.class.UserMeetingInvite
    ) as Array<TxCreateDoc<UserMeetingInvite>>
    expect(responseCreates.some((c) => c.attributes.to === recipient)).toBe(true)
  })

  it('does not push members again if the recipient is already a member', async () => {
    const fixtures: Fixtures = {
      meetings: [meetingDoc({ members: [callerAccount, recipientAccount] })],
      spaces: [personSpace('space:recipient', recipient)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    const req = inviteRequest(caller, recipient, meetingId)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    expect(memberPushUpdates(result)).toHaveLength(0)
  })

  it('does not push members for a public meeting (recipient sees it anyway)', async () => {
    const fixtures: Fixtures = {
      meetings: [meetingDoc({ private: false })],
      spaces: [personSpace('space:recipient', recipient)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    const req = inviteRequest(caller, recipient, meetingId)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    expect(memberPushUpdates(result)).toHaveLength(0)
  })

  it('drops the request entirely when a non-owner invites into a private meeting', async () => {
    const fixtures: Fixtures = {
      meetings: [meetingDoc()],
      spaces: [personSpace('space:recipient', recipient)],
      removedMap: new Map()
    }
    const control = createControl(fixtures)
    // stranger is neither owner nor member.
    const req = inviteRequest(stranger, recipient, meetingId)
    const result = await OnUserMeetingInvite([buildCreateInviteRequestTx(req)], control)

    // No member push and no invite-response — the request is silently dropped.
    expect(memberPushUpdates(result)).toHaveLength(0)
    const responseCreates = result.filter(
      (t) =>
        t._class === core.class.TxCreateDoc &&
        (t as TxCreateDoc<UserMeetingInvite>).objectClass === love.class.UserMeetingInvite
    )
    expect(responseCreates).toHaveLength(0)
  })
})

void contact
