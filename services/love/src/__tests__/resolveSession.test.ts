//
// Copyright © 2026 Intabia Fusion.
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
import calendar, { AccessLevel } from '@hcengineering/calendar'
import contact from '@hcengineering/contact'
import { type Class, type Doc, type DocumentQuery, type Ref } from '@hcengineering/core'
import love, { MeetingStatus } from '@hcengineering/love'
import { WorkspaceClient } from '../workspaceClient'
import { createMockContext } from './test-helpers'

const hour = 60 * 60 * 1000
const start = new Date('2026-03-02T10:00:00Z').getTime()

interface FakeOpts {
  events?: any[]
  meetings?: any[]
  persons?: any[]
  identities?: any[]
  /** commit() verdicts, consumed in order; missing entries mean success. */
  commits?: boolean[]
  /** Rows a losing commit reveals - a session another creator opened first. */
  onLostCommit?: () => void
}

function makeClient (opts: FakeOpts): { wc: WorkspaceClient, created: any[], applyIds: string[] } {
  const created: any[] = []
  const applyIds: string[] = []
  const commits = [...(opts.commits ?? [])]

  const match = (rows: any[], query: any): any[] =>
    rows.filter((row) =>
      Object.entries(query).every(([key, cond]: [string, any]) => {
        const value = row[key]
        if (cond !== null && typeof cond === 'object' && cond.$in !== undefined) return cond.$in.includes(value)
        return value === cond
      })
    )

  const rowsFor = (_class: Ref<Class<Doc>>): any[] => {
    if (_class === calendar.class.Event) return opts.events ?? []
    if (_class === love.class.MeetingMinutes) return opts.meetings ?? []
    if (_class === contact.class.Person) return opts.persons ?? []
    if (_class === contact.class.SocialIdentity) return opts.identities ?? []
    return []
  }

  const client = {
    findOne: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      // A freshly created session must be readable back, exactly as from a real database.
      if (_class === love.class.MeetingMinutes) {
        const fresh = created.find((it) => (query as any)._id === it._id)
        if (fresh !== undefined) return fresh
      }
      return match(rowsFor(_class as Ref<Class<Doc>>), query)[0]
    }),
    findAll: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) =>
      match(rowsFor(_class as Ref<Class<Doc>>), query)
    )
  }

  const txOps = {
    apply: (id: string) => {
      applyIds.push(id)
      let pending: any
      return {
        notMatch: jest.fn(),
        createDoc: jest.fn(async (_class: any, space: any, data: any, _id: any) => {
          pending = { ...data, _id, _class }
          return _id
        }),
        commit: jest.fn(async () => {
          const verdict = commits.length > 0 ? commits.shift() : true
          if (verdict === true) created.push(pending)
          else opts.onLostCommit?.()
          return { result: verdict }
        })
      }
    }
  }

  const wc = Object.create(WorkspaceClient.prototype)
  wc.ctx = createMockContext()
  wc.client = client
  wc.txOps = txOps
  wc.workspace = 'ws-1'
  return { wc: wc as WorkspaceClient, created, applyIds }
}

function masterEvent (extra: Record<string, unknown> = {}): any {
  return {
    _id: 'ev-master',
    _class: calendar.class.Event,
    eventId: 'E1',
    access: AccessLevel.Owner,
    date: start,
    dueDate: start + hour,
    title: 'Weekly sync',
    participants: ['person-1'],
    user: 'social-1',
    ...extra
  }
}

function liveSession (extra: Record<string, unknown> = {}): any {
  return { _id: 'mm-live', _class: love.class.MeetingMinutes, eventId: 'E1', status: MeetingStatus.Active, ...extra }
}

describe('WorkspaceClient.resolveSession', () => {
  it('returns the session already running for the series', async () => {
    const { wc, created } = makeClient({ events: [masterEvent()], meetings: [liveSession()] })

    const res = await wc.resolveSession('E1', start)

    expect(res).toEqual({ meeting: expect.objectContaining({ _id: 'mm-live' }) })
    expect(created).toHaveLength(0)
  })

  it('opens a session pinned to the occurrence and to the service room', async () => {
    const { wc, created, applyIds } = makeClient({
      events: [masterEvent()],
      persons: [{ _id: 'person-1', _class: contact.class.Person, personUuid: 'acc-1' }],
      identities: [{ _id: 'social-1', _class: contact.class.SocialIdentity, attachedTo: 'person-1' }]
    })

    const res = await wc.resolveSession('E1', start)

    expect(res).toMatchObject({ created: true })
    expect(created[0]).toMatchObject({
      eventId: 'E1',
      occurrence: start,
      roomId: love.ids.ScheduledRoom,
      status: MeetingStatus.Pending,
      name: 'Weekly sync',
      members: ['acc-1'],
      owners: ['acc-1']
    })
    // One apply key per series, so concurrent creators contend rather than pass each other.
    expect(applyIds).toEqual(['love_session_E1'])
  })

  it('refuses outside the occurrence window and says when to come back', async () => {
    const series = masterEvent({ rules: [{ freq: 'DAILY', interval: 1 }] })
    const { wc, created } = makeClient({ events: [series] })

    const res = await wc.resolveSession('E1', start - 3 * hour)

    expect(res).toEqual({ error: 'no-occurrence', nextOccurrence: start })
    expect(created).toHaveLength(0)
  })

  it('resolves an overridden occurrence through its series master', async () => {
    // The override owns a different eventId; the session still belongs to the series.
    const override = {
      ...masterEvent(),
      _id: 'ev-override',
      _class: calendar.class.ReccuringInstance,
      eventId: 'E2',
      recurringEventId: 'E1'
    }
    const { wc } = makeClient({ events: [masterEvent(), override], meetings: [liveSession()] })

    const res = await wc.resolveSession('E2', start)

    expect(res).toEqual({ meeting: expect.objectContaining({ _id: 'mm-live' }) })
  })

  it('yields to a creator that won the race and returns their session', async () => {
    const meetings: any[] = []
    const { wc, created } = makeClient({
      events: [masterEvent()],
      meetings,
      commits: [false],
      onLostCommit: () => meetings.push(liveSession({ _id: 'mm-other' }))
    })

    const res = await wc.resolveSession('E1', start)

    expect(res).toEqual({ meeting: expect.objectContaining({ _id: 'mm-other' }) })
    expect(created).toHaveLength(0)
  })

  it('reports a missing event rather than inventing a session', async () => {
    const { wc } = makeClient({ events: [] })
    expect(await wc.resolveSession('E1', start)).toEqual({ error: 'not-found' })
  })

  it('ignores a participant copy when resolving the master', async () => {
    const copy = { ...masterEvent(), _id: 'ev-copy', access: AccessLevel.Reader }
    const { wc, created } = makeClient({ events: [copy] })

    // Only copies exist - there is no series to open a session for.
    expect(await wc.resolveSession('E1', start)).toEqual({ error: 'not-found' })
    expect(created).toHaveLength(0)
  })
})
