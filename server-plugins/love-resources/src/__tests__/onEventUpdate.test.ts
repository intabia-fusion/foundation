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
  type AccountUuid,
  type Class,
  type Doc,
  generateId,
  type MeasureContext,
  type PersonId,
  type PersonUuid,
  type Ref,
  type Space,
  toFindResult,
  type Tx,
  TxFactory,
  type TxUpdateDoc
} from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'
import contact, { type Person } from '@hcengineering/contact'
import calendar, { type Event } from '@hcengineering/calendar'
import love, { MeetingStatus, type MeetingMinutes, type MeetingEventLink, type Room } from '@hcengineering/love'
import { OnEventUpdate } from '../index'

// -- Fixtures --

const meetingRef = 'meeting:1' as Ref<MeetingMinutes>
const roomRef = 'room:1' as Ref<Room>
const eventRef = 'event:1' as Ref<Event>
const personA = 'person:a' as Ref<Person>
const personB = 'person:b' as Ref<Person>
const accountA = 'account:a' as AccountUuid
const accountB = 'account:b' as AccountUuid

function createMeetingDoc (opts?: { status?: MeetingStatus, members?: AccountUuid[] }): MeetingMinutes {
  return {
    _id: meetingRef,
    _class: love.class.MeetingMinutes,
    space: meetingRef as unknown as Ref<Space>,
    name: 'Test Meeting',
    description: '',
    private: false,
    archived: false,
    members: opts?.members ?? [accountA],
    owners: [accountA],
    status: opts?.status ?? MeetingStatus.Scheduled,
    roomId: roomRef,
    modifiedOn: Date.now(),
    modifiedBy: core.account.System
  } as unknown as MeetingMinutes
}

function createEvent (opts?: { participants?: Array<Ref<Person>>, date?: number }): Event {
  const ev = {
    _id: eventRef,
    _class: calendar.class.Event,
    space: core.space.Workspace,
    title: 'Test Event',
    description: '',
    date: opts?.date ?? Date.now(),
    dueDate: (opts?.date ?? Date.now()) + 3600000,
    participants: opts?.participants ?? [personA],
    modifiedOn: Date.now(),
    modifiedBy: 'creator' as PersonId,
    allDay: false
  } as unknown as Event
  return ev
}

function createPersonDoc (id: Ref<Person>, uuid?: PersonUuid): Person {
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

function createUpdateTx (ops: Partial<Event>): TxUpdateDoc<Event> {
  return {
    _id: generateId(),
    _class: core.class.TxUpdateDoc,
    space: core.space.DerivedTx,
    objectId: eventRef,
    objectClass: calendar.class.Event,
    objectSpace: core.space.Workspace,
    modifiedOn: Date.now(),
    modifiedBy: 'creator' as PersonId,
    operations: ops
  } satisfies TxUpdateDoc<Event>
}

type FindAllFn = (_class: Ref<Class<Doc>>, query: any) => Doc[]

function createMockControl (findAllImpl: FindAllFn): TriggerControl {
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
      return toFindResult(findAllImpl(_class, query))
    }),
    txFactory: new TxFactory(core.account.System, true),
    hierarchy: {
      isDerived: (_class: Ref<Class<Doc>>, base: Ref<Class<Doc>>) => _class === base,
      hasMixin: (_doc: Doc, _mixin: Ref<Class<Doc>>) => true,
      as: (doc: Doc) => ({ ...doc, meetingId: meetingRef, room: roomRef }) as unknown as MeetingEventLink
    } as any,
    modelDb: {} as any,
    removedMap: new Map(),
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

function buildFindAll (opts: { meeting?: MeetingMinutes, event?: Event, persons?: Person[] }): FindAllFn {
  return (_class, query) => {
    if (_class === love.class.MeetingMinutes) {
      return opts.meeting !== undefined ? [opts.meeting] : []
    }
    if (_class === calendar.class.Event) {
      return opts.event !== undefined ? [opts.event] : []
    }
    if (_class === contact.class.Person) {
      const person = opts.persons?.find((p) => p._id === query._id)
      return person !== undefined ? [person] : []
    }
    return []
  }
}

function getUpdateOps (txes: Tx[]): any[] {
  return txes
    .filter((tx) => tx._class === core.class.TxUpdateDoc)
    .map((tx) => (tx as TxUpdateDoc<MeetingMinutes>).operations)
}

// -- Tests --

describe('OnEventUpdate', () => {
  describe('date update', () => {
    it('should update meetingScheduledDate when Event date changes', async () => {
      const newDate = Date.now() + 86400000
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc(),
          event: createEvent({ date: newDate })
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ date: newDate })], control)
      const ops = getUpdateOps(result)

      expect(ops).toHaveLength(1)
      expect(ops[0].meetingScheduledDate).toBe(newDate)
    })
  })

  describe('members update with $push', () => {
    it('should use $push to add new members', async () => {
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ members: [accountA] }),
          event: createEvent({ participants: [personA, personB] }),
          persons: [createPersonDoc(personA, accountA), createPersonDoc(personB, accountB)]
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ participants: [personA, personB] })], control)
      const ops = getUpdateOps(result)

      expect(ops).toHaveLength(1)
      // Should use $push, NOT full members array replacement
      expect(ops[0].$push).toBeDefined()
      expect(ops[0].$push.members).toBeDefined()
      expect(ops[0].$push.members.$each).toEqual([accountB])
      // Should NOT have flat members field
      expect(ops[0].members).toBeUndefined()
    })

    it('should not produce update when all participants already members', async () => {
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ members: [accountA, accountB] }),
          event: createEvent({ participants: [personA, personB] }),
          persons: [createPersonDoc(personA, accountA), createPersonDoc(personB, accountB)]
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ participants: [personA, personB] })], control)
      const ops = getUpdateOps(result)

      expect(ops).toHaveLength(0)
    })

    it('should skip participants without personUuid', async () => {
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ members: [accountA] }),
          event: createEvent({ participants: [personA, personB] }),
          persons: [
            createPersonDoc(personA, accountA),
            createPersonDoc(personB, undefined) // no personUuid
          ]
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ participants: [personA, personB] })], control)
      const ops = getUpdateOps(result)

      // No new members to add (personA already member, personB has no uuid)
      expect(ops).toHaveLength(0)
    })
  })

  describe('status filtering', () => {
    it('should skip update when meeting is not Scheduled', async () => {
      const newDate = Date.now() + 86400000
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ status: MeetingStatus.Active }),
          event: createEvent()
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ date: newDate })], control)

      expect(result).toHaveLength(0)
    })

    it('should skip update when meeting is Finished', async () => {
      const newDate = Date.now() + 86400000
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ status: MeetingStatus.Finished }),
          event: createEvent()
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ date: newDate })], control)

      expect(result).toHaveLength(0)
    })
  })

  describe('tx filtering', () => {
    it('should ignore TxMixin transactions', async () => {
      const tx = createUpdateTx({ date: Date.now() + 86400000 })
      ;(tx as any)._class = core.class.TxMixin

      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc(),
          event: createEvent()
        })
      )

      const result = await OnEventUpdate([tx], control)

      expect(result).toHaveLength(0)
    })

    it('should ignore TxCreateDoc transactions', async () => {
      const tx = createUpdateTx({ date: Date.now() + 86400000 })
      ;(tx as any)._class = core.class.TxCreateDoc

      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc(),
          event: createEvent()
        })
      )

      const result = await OnEventUpdate([tx], control)

      expect(result).toHaveLength(0)
    })
  })

  describe('combined updates', () => {
    it('should handle date and members update in single tx', async () => {
      const newDate = Date.now() + 86400000
      const control = createMockControl(
        buildFindAll({
          meeting: createMeetingDoc({ members: [accountA] }),
          event: createEvent({ participants: [personA, personB], date: newDate }),
          persons: [createPersonDoc(personA, accountA), createPersonDoc(personB, accountB)]
        })
      )

      const result = await OnEventUpdate([createUpdateTx({ date: newDate, participants: [personA, personB] })], control)
      const ops = getUpdateOps(result)

      expect(ops).toHaveLength(1)
      expect(ops[0].meetingScheduledDate).toBe(newDate)
      expect(ops[0].$push.members.$each).toEqual([accountB])
    })
  })
})
