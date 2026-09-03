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

import { type Class, type Doc, type DocumentQuery, type MeasureContext, type Ref } from '@hcengineering/core'
import love, { type MeetingMinutes, type ParticipantInfo, type Room } from '@hcengineering/love'
import { createMockContext, createMockMeeting, createMockRoom, TEST_IDS } from './test-helpers'
import { WorkspaceClient } from '../workspaceClient'

// Fake of the client surface `upsertParticipantFromLiveKit` touches. The occupancy read reflects
// rows created so far, like a real database - collisions then depend on the code, not the fake.
function createFakeClient (opts: { meeting: MeetingMinutes, room?: Room, participantsSnapshot?: ParticipantInfo[] }): {
  client: any
  createDocCalls: Array<{ data: any, id: any }>
} {
  const createDocCalls: Array<{ data: any, id: any }> = []
  const participantsSnapshot = opts.participantsSnapshot ?? []

  const client = {
    findOne: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      if (_class === love.class.MeetingMinutes) {
        return ((query as any)._id === opts.meeting._id ? opts.meeting : undefined) as T | undefined
      }
      if (_class === love.class.Room) {
        return (opts.room !== undefined && (query as any)._id === opts.room._id ? opts.room : undefined) as
          | T
          | undefined
      }
      return undefined
    }),
    findAll: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      if (_class === love.class.ParticipantInfo) {
        const q = query as any
        // Existing-record lookup (person+meeting+sessionId): none pre-exist in these tests.
        if (q.sessionId !== undefined) return [] as unknown as T[]
        // Room-occupancy read used for placement: seed plus everything created so far.
        return [...participantsSnapshot, ...createDocCalls.map((c) => c.data)] as unknown as T[]
      }
      return [] as unknown as T[]
    }),
    createDoc: jest.fn(async (_class: any, _space: any, data: any, id: any) => {
      createDocCalls.push({ data, id })
      return id
    })
  }
  return { client, createDocCalls }
}

function makeWorkspaceClient (ctx: MeasureContext, client: any): WorkspaceClient {
  // Bypass private constructor - upsertParticipantFromLiveKit only reaches ctx/client, never the network plumbing.
  const wc = Object.create(WorkspaceClient.prototype)
  wc.ctx = ctx
  wc.client = client
  return wc as WorkspaceClient
}

describe('WorkspaceClient.upsertParticipantFromLiveKit → new ParticipantInfo shape (defect C)', () => {
  it('sets kind on a newly created ParticipantInfo (defect: kind is never set on create)', async () => {
    const meeting = createMockMeeting({ roomId: undefined })
    const { client, createDocCalls } = createFakeClient({ meeting })
    const wc = makeWorkspaceClient(createMockContext(), client)

    await wc.upsertParticipantFromLiveKit(TEST_IDS.person1, 'Alice', null, meeting._id, 'session-1', {})

    expect(createDocCalls).toHaveLength(1)
    expect(createDocCalls[0].data.kind).toBe('user')
  })
})

describe('WorkspaceClient.upsertParticipantFromLiveKit → room-place allocation race (defect D)', () => {
  it('gives two concurrent joiners different seats (defect: unlocked read-then-create allocates the same cell)', async () => {
    const room = createMockRoom({ _id: TEST_IDS.room })
    const meeting = createMockMeeting({ roomId: room._id })
    const { client, createDocCalls } = createFakeClient({ meeting, room, participantsSnapshot: [] })
    const wc = makeWorkspaceClient(createMockContext(), client)

    // Two different people join the same meeting "at the same time".
    await Promise.all([
      wc.upsertParticipantFromLiveKit(TEST_IDS.person1, 'Alice', null, meeting._id, 'session-a', {}),
      wc.upsertParticipantFromLiveKit(TEST_IDS.person2, 'Bob', null, meeting._id, 'session-b', {})
    ])

    expect(createDocCalls).toHaveLength(2)
    const [a, b] = createDocCalls.map((c) => ({ x: c.data.x, y: c.data.y }))
    expect(a).not.toEqual(b)
  })
})
