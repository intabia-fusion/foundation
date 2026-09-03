//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

import core, {
  type Class,
  type Doc,
  type DocumentQuery,
  type DocumentUpdate,
  type MeasureContext,
  type Ref
} from '@hcengineering/core'
import love, {
  SCHEDULED_MEETING_WINDOW_MS,
  MeetingStatus,
  type MeetingMinutes,
  type ParticipantInfo,
  type Room,
  type UserMeetingInvite
} from '@hcengineering/love'
import { createMockContext, createMockMeeting, createMockParticipant, TEST_IDS } from './test-helpers'
import { WorkspaceClient } from '../workspaceClient'

// Lightweight in-memory fake of the platform client surface that `WorkspaceClient.finishMeeting` touches.
function createFakeClient (seed: {
  meeting: MeetingMinutes
  participants?: ParticipantInfo[]
  invites?: UserMeetingInvite[]
}): { client: any, removed: Ref<Doc>[], updated: Array<{ doc: Doc, update: DocumentUpdate<Doc> }> } {
  const meetings = new Map<Ref<MeetingMinutes>, MeetingMinutes>()
  meetings.set(seed.meeting._id, { ...seed.meeting })
  const participants = (seed.participants ?? []).map((p) => ({ ...p }))
  const invites = (seed.invites ?? []).map((i) => ({ ...i }))

  const removed: Ref<Doc>[] = []
  const updated: Array<{ doc: Doc, update: DocumentUpdate<Doc> }> = []

  const client = {
    findOne: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      if (_class === love.class.MeetingMinutes) {
        return meetings.get((query as any)._id as Ref<MeetingMinutes>) as T | undefined
      }
      return undefined
    }),
    findAll: jest.fn(async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      if (_class === love.class.ParticipantInfo) {
        return participants.filter((p) => p.meeting === (query as any).meeting) as unknown as T[]
      }
      if (_class === love.class.UserMeetingInvite) {
        const q = query as any
        return invites.filter((it) => {
          if (q.meeting !== undefined) return it.meeting === q.meeting
          if (q.room !== undefined) return it.room === q.room
          return true
        }) as unknown as T[]
      }
      return [] as unknown as T[]
    }),
    update: jest.fn(async (doc: Doc, update: DocumentUpdate<Doc>) => {
      updated.push({ doc, update })
      if (doc._class === love.class.MeetingMinutes) {
        meetings.set(doc._id as Ref<MeetingMinutes>, { ...(doc as MeetingMinutes), ...(update as any) })
      }
    }),
    remove: jest.fn(async (doc: Doc) => {
      removed.push(doc._id)
    })
  }
  return { client, removed, updated }
}

function makeWorkspaceClient (ctx: MeasureContext, client: any): WorkspaceClient {
  // Bypass private constructor for the unit test — `finishMeeting` only
  // reaches the fields we wire up below, never the network plumbing.
  const wc = Object.create(WorkspaceClient.prototype)
  wc.ctx = ctx
  wc.client = client
  return wc as WorkspaceClient
}

const meetingRef = TEST_IDS.meeting
const roomRef = TEST_IDS.room

function invite (overrides: Partial<UserMeetingInvite> & { _id: string }): UserMeetingInvite {
  return {
    _class: love.class.UserMeetingInvite,
    space: core.space.Workspace,
    kind: 'invite-request',
    from: 'person:caller' as any,
    to: 'person:recipient' as any,
    status: 'pending',
    modifiedOn: Date.now(),
    modifiedBy: 'sid:caller' as any,
    createdOn: Date.now(),
    createdBy: 'sid:caller' as any,
    ...overrides,
    _id: overrides._id as Ref<UserMeetingInvite>
  } satisfies UserMeetingInvite
}

describe('WorkspaceClient.finishMeeting → re-arm vs finish', () => {
  it('re-arms a future-scheduled meeting to Scheduled instead of finishing (still cleans up participants)', async () => {
    const meeting = createMockMeeting({
      status: MeetingStatus.Active,
      meetingScheduledDate: Date.now() + 24 * 60 * 60 * 1000
    })
    const participant = createMockParticipant({ meeting: meeting._id })
    const { client, updated, removed } = createFakeClient({ meeting, participants: [participant] })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id)

    const meetingUpdate = updated.find((u) => u.doc._id === meeting._id)
    expect(meetingUpdate?.update).toEqual({ status: MeetingStatus.Scheduled })
    expect(meetingUpdate?.update).not.toHaveProperty('meetingEnd')
    expect(removed).toContain(TEST_IDS.participant1)
  })

  it('finishes a scheduled meeting once it is past its window (with meetingEnd)', async () => {
    const meeting = createMockMeeting({
      status: MeetingStatus.Active,
      meetingScheduledDate: Date.now() - (SCHEDULED_MEETING_WINDOW_MS + 60_000)
    })
    const { client, updated } = createFakeClient({ meeting })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id, 123456)

    const meetingUpdate = updated.find((u) => u.doc._id === meeting._id)
    expect(meetingUpdate?.update).toEqual({ status: MeetingStatus.Finished, meetingEnd: 123456 })
  })

  it('re-arms a running scheduled meeting instead of finishing it (defect: re-arm only before start)', async () => {
    // Everyone briefly dropped mid-meeting, so scheduledDate is already past: a re-arm check of
    // `scheduledDate > now` would give the still-running meeting a terminal Finished.
    const meeting = createMockMeeting({
      status: MeetingStatus.Active,
      meetingScheduledDate: Date.now() - 2 * 60 * 1000
    })
    const { client, updated } = createFakeClient({ meeting })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id, Date.now())

    const meetingUpdate = updated.find((u) => u.doc._id === meeting._id)
    expect(meetingUpdate?.update).toEqual({ status: MeetingStatus.Scheduled })
  })

  it('finishes an ad-hoc meeting without meetingScheduledDate as before', async () => {
    const meeting = createMockMeeting({ status: MeetingStatus.Active, meetingScheduledDate: undefined })
    const { client, updated } = createFakeClient({ meeting })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id, 123456)

    const meetingUpdate = updated.find((u) => u.doc._id === meeting._id)
    expect(meetingUpdate?.update).toEqual({ status: MeetingStatus.Finished, meetingEnd: 123456 })
  })
})

describe('WorkspaceClient.finishMeeting → invite cleanup', () => {
  it('drops every UserMeetingInvite that targeted the finished meeting (by meeting id)', async () => {
    const meeting = createMockMeeting({ roomId: roomRef, status: MeetingStatus.Active })
    const matching = [
      invite({ _id: 'inv:1' as Ref<UserMeetingInvite>, kind: 'invite-request', meeting: meetingRef }),
      invite({ _id: 'inv:2' as Ref<UserMeetingInvite>, kind: 'invite-response', meeting: meetingRef })
    ]
    const unrelated = invite({
      _id: 'inv:other' as Ref<UserMeetingInvite>,
      meeting: 'some-other-meeting' as Ref<MeetingMinutes>
    })
    const { client, removed } = createFakeClient({
      meeting,
      invites: [...matching, unrelated]
    })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id)

    expect(removed).toEqual(expect.arrayContaining(matching.map((i) => i._id)))
    expect(removed).not.toContain(unrelated._id)
  })

  it('drops knock invites that referenced the room even without a `meeting` field', async () => {
    const meeting = createMockMeeting({ roomId: roomRef, status: MeetingStatus.Active })
    const knockRequest = invite({
      _id: 'inv:knock' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      room: roomRef,
      meeting: undefined
    })
    const { client, removed } = createFakeClient({ meeting, invites: [knockRequest] })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id)

    expect(removed).toContain(knockRequest._id)
  })

  it('does not touch invites for other meetings/rooms', async () => {
    const meeting = createMockMeeting({ roomId: roomRef, status: MeetingStatus.Active })
    const otherRoom = 'room:other' as Ref<Room>
    const otherMeetingInvite = invite({
      _id: 'inv:other-meeting' as Ref<UserMeetingInvite>,
      meeting: 'meeting:other' as Ref<MeetingMinutes>
    })
    const otherRoomInvite = invite({
      _id: 'inv:other-room' as Ref<UserMeetingInvite>,
      kind: 'invite-request',
      room: otherRoom,
      meeting: undefined
    })
    const { client, removed } = createFakeClient({
      meeting,
      invites: [otherMeetingInvite, otherRoomInvite]
    })

    const wc = makeWorkspaceClient(createMockContext(), client)
    await wc.finishMeeting(meeting._id)

    expect(removed).toEqual([])
  })
})
