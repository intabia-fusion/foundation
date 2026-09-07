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

import { Ref, WorkspaceUuid } from '@hcengineering/core'
import { Person } from '@hcengineering/contact'
import { MeetingMinutes } from '@hcengineering/love'
import { LiveKitPollingService } from '../polling'
import { WorkspaceClient } from '../workspaceClient'
import { createMockContext } from './test-helpers'

jest.mock('../workspaceClient')

const workspace = 'workspace-1' as WorkspaceUuid
const meetingId = 'meeting-1' as Ref<MeetingMinutes>
const roomName = `${workspace}_${meetingId}`

function createMockRoomClient (): {
  listRooms: jest.Mock
  listParticipants: jest.Mock
  deleteRoom: jest.Mock
  updateRoomMetadata: jest.Mock
} {
  return {
    listRooms: jest.fn().mockResolvedValue([]),
    listParticipants: jest.fn().mockResolvedValue([]),
    deleteRoom: jest.fn().mockResolvedValue(undefined),
    updateRoomMetadata: jest.fn().mockResolvedValue(undefined)
  }
}

// Plain object of jest.fn props (not jest.Mocked<WorkspaceClient>) so expect(wsClient.fn) passes unbound-method lint.
function createMockWsClient (): Record<string, jest.Mock> {
  return {
    checkUnfinishedMeetings: jest.fn().mockResolvedValue(undefined),
    finishMeeting: jest.fn().mockResolvedValue(undefined),
    findParticipantInfosByMeeting: jest.fn().mockResolvedValue([]),
    findPendingRecordingsByMeeting: jest.fn().mockResolvedValue([]),
    removeParticipantInfoById: jest.fn().mockResolvedValue(undefined),
    findPersonRefById: jest.fn().mockResolvedValue(undefined),
    findMeetingById: jest.fn().mockResolvedValue({ _id: meetingId, roomId: 'office-1' }),
    findOfficeOwner: jest.fn().mockResolvedValue(undefined),
    upsertParticipantFromLiveKit: jest.fn().mockResolvedValue(undefined),
    removeParticipantFromLiveKit: jest.fn().mockResolvedValue(undefined),
    cleanupOrphanedParticipantInfos: jest.fn().mockResolvedValue(undefined),
    cleanupOrphanedPendingRecordings: jest.fn().mockResolvedValue(undefined)
  }
}

describe('LiveKitPollingService.poll', () => {
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: Record<string, jest.Mock>
  let billingProducer: { send: jest.Mock, close: jest.Mock }
  let service: LiveKitPollingService

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    billingProducer = { send: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) }
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      {
        intervalMs: 1000,
        projectKey: 'test-project',
        ownerRejoinGraceMs: 15000
      },
      billingProducer as any
    )
    // isRunning gate blocks poll() unless start()/stop() flips it; set directly to skip the setInterval side effects.
    ;(service as any).isRunning = true
  })

  describe('idle back-off', () => {
    it('stretches the interval after three empty cycles and a webhook brings it back', async () => {
      jest.useFakeTimers()
      try {
        roomClient.listRooms.mockResolvedValue([])
        const svc = service as any

        // Three empty polls arm the back-off; the fourth wait is the long one.
        for (let i = 0; i < 3; i++) await svc.poll()
        expect(svc.idleCycles).toBe(3)
        svc.scheduleNext()
        expect(jest.getTimerCount()).toBe(1)

        // Nothing fires at the base interval any more.
        jest.advanceTimersByTime(1000)
        const afterBase = roomClient.listRooms.mock.calls.length
        expect(afterBase).toBe(3)

        // A webhook resets the counter and polls immediately.
        svc.wakeUp()
        expect(svc.idleCycles).toBe(0)
        // Let the woken cycle settle, then stop so it cannot arm a real timer.
        service.stop()
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        jest.clearAllTimers()
        jest.useRealTimers()
      }
    })
  })

  it('passes current snapshot meetingIds to checkUnfinishedMeetings, respecting the workspace filter', async () => {
    roomClient.listRooms.mockResolvedValue([
      { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }) },
      { name: 'other-ws_meeting-2', metadata: JSON.stringify({ projectKey: 'test-project' }) }
    ])
    service.addWorkspaceToCheck(workspace)

    await (service as any).poll()

    expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledWith([meetingId])
  })

  it('cleanupStaleRoomStates finishes the meeting for a room that disappeared between polls', async () => {
    roomClient.listRooms.mockResolvedValueOnce([
      { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }) }
    ])
    await (service as any).poll()
    expect((service as any).roomStates.has(roomName)).toBe(true)

    roomClient.listRooms.mockResolvedValueOnce([])
    await (service as any).poll()

    expect(wsClient.finishMeeting).toHaveBeenCalledWith(meetingId, expect.any(Number))
    expect((service as any).roomStates.has(roomName)).toBe(false)
  })

  describe('LiveKit outage drain', () => {
    it('does not drain on the first failing poll', async () => {
      roomClient.listRooms.mockRejectedValue(new Error('unreachable'))

      await (service as any).poll()

      expect(wsClient.checkUnfinishedMeetings).not.toHaveBeenCalled()
    })

    it('drains once per outage once both bars are cleared, and does not re-drain within the same outage', async () => {
      roomClient.listRooms.mockRejectedValue(new Error('unreachable'))
      service.addWorkspaceToCheck(workspace)

      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now')

      // Five failures spread past the five-minute mark: neither bar alone triggers the drain.
      for (let i = 0; i < 4; i++) {
        dateSpy.mockReturnValue(now + i * 60_000)
        await (service as any).poll()
      }
      expect(wsClient.checkUnfinishedMeetings).not.toHaveBeenCalled()

      dateSpy.mockReturnValue(now + 5 * 60_000 + 1)
      await (service as any).poll()

      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledTimes(1)
      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledWith([])

      dateSpy.mockReturnValue(now + 10 * 60_000)
      await (service as any).poll() // still the same outage -> no re-drain

      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledTimes(1)

      dateSpy.mockRestore()
    })

    it('does not drain on a burst of failures inside one second', async () => {
      roomClient.listRooms.mockRejectedValue(new Error('unreachable'))
      service.addWorkspaceToCheck(workspace)

      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      for (let i = 0; i < 10; i++) {
        await (service as any).poll()
      }

      expect(wsClient.checkUnfinishedMeetings).not.toHaveBeenCalled()
      dateSpy.mockRestore()
    })

    async function driveOutageToDrain (dateSpy: jest.SpyInstance, from: number): Promise<void> {
      for (let i = 0; i < 4; i++) {
        dateSpy.mockReturnValue(from + i * 60_000)
        await (service as any).poll()
      }
      dateSpy.mockReturnValue(from + 5 * 60_000 + 1)
      await (service as any).poll()
    }

    it('resets the outage tracker after a successful poll', async () => {
      roomClient.listRooms.mockRejectedValue(new Error('unreachable'))
      service.addWorkspaceToCheck(workspace)

      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now')
      await driveOutageToDrain(dateSpy, now)
      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledTimes(1)
      dateSpy.mockRestore()

      // Successful poll clears livekitFailureSince/livekitDrainedAt (also drains workspacesToCheck normally -> +1 call).
      roomClient.listRooms.mockResolvedValue([])
      await (service as any).poll()
      expect((service as any).livekitFailureSince).toBeNull()
      expect((service as any).livekitDrainedAt).toBeNull()
      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledTimes(2)

      // A fresh outage should be able to drain again.
      roomClient.listRooms.mockRejectedValue(new Error('unreachable again'))
      service.addWorkspaceToCheck(workspace)
      const now2 = Date.now()
      const dateSpy2 = jest.spyOn(Date, 'now')
      await driveOutageToDrain(dateSpy2, now2)
      expect(wsClient.checkUnfinishedMeetings).toHaveBeenCalledTimes(3)
      dateSpy2.mockRestore()
    })
  })

  describe('LiveKit outage threshold (defect A: LIVEKIT_OUTAGE_MS too low)', () => {
    it('does not drain meetings after a 15s LiveKit blip (defect: LIVEKIT_OUTAGE_MS too low)', async () => {
      jest.useFakeTimers()
      try {
        const start = Date.now()
        jest.setSystemTime(start)
        roomClient.listRooms.mockRejectedValue(new Error('unreachable'))
        service.addWorkspaceToCheck(workspace)

        await (service as any).poll() // failure #1, starts the outage clock

        // A 15s blip (or a quick LiveKit restart) must not force-finish every active meeting.
        jest.setSystemTime(start + 15_000)
        await (service as any).poll()

        expect(wsClient.checkUnfinishedMeetings).not.toHaveBeenCalled()
      } finally {
        jest.clearAllTimers()
        jest.useRealTimers()
      }
    })
  })

  describe('meeting-minutes billing', () => {
    const activeRoom = { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }) }

    // LiveKit reports joinedAt in seconds; polling.ts scales anything below 1e12 to ms.
    function participant (sid: string, joinedAtSec: number, agent = false): any {
      return {
        sid,
        identity: `identity-${sid}`,
        joinedAt: joinedAtSec,
        permission: agent ? { agent: true } : undefined
      }
    }

    function usageDeltas (): any[] {
      return billingProducer.send.mock.calls.flatMap((call) => call[2]).filter((m) => m.metric === 'meetingMinutes')
    }

    it('bills only the un-sent delta on each poll', async () => {
      const now = Date.now()
      const joinedAtSec = Math.floor(now / 1000) - 60
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValue([activeRoom])
      roomClient.listParticipants.mockResolvedValue([participant('sid-1', joinedAtSec)])

      await (service as any).poll()
      dateSpy.mockReturnValue(now + 30_000)
      await (service as any).poll()

      // 60s elapsed at the first poll, then only the following 30s.
      expect(usageDeltas().map((m) => m.amount)).toEqual([60, 30])
      dateSpy.mockRestore()
    })

    it('uses a distinct idempotency ref per cumulative total', async () => {
      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValue([activeRoom])
      roomClient.listParticipants.mockResolvedValue([participant('sid-1', Math.floor(now / 1000) - 10)])

      await (service as any).poll()
      dateSpy.mockReturnValue(now + 30_000)
      await (service as any).poll()

      const refs = usageDeltas().map((m) => m.ref)
      expect(new Set(refs).size).toBe(refs.length)
      expect(refs[0]).toContain('sid-1')
      dateSpy.mockRestore()
    })

    it('does not bill agent participants', async () => {
      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValue([activeRoom])
      roomClient.listParticipants.mockResolvedValue([participant('agent-1', Math.floor(now / 1000) - 60, true)])

      await (service as any).poll()

      expect(usageDeltas()).toHaveLength(0)
      dateSpy.mockRestore()
    })

    it('stops billing a participant who left, even when the room lives on', async () => {
      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValue([activeRoom])
      roomClient.listParticipants.mockResolvedValueOnce([participant('sid-1', Math.floor(now / 1000) - 60)])

      await (service as any).poll()
      const afterFirst = usageDeltas().length

      // Participant is gone; the room keeps running for another hour.
      roomClient.listParticipants.mockResolvedValue([])
      dateSpy.mockReturnValue(now + 3_600_000)
      await (service as any).poll()

      expect(usageDeltas()).toHaveLength(afterFirst)
      expect((service as any).roomStates.get(roomName).sentByParticipant.size).toBe(0)
      dateSpy.mockRestore()
    })

    it('does not bill a departed participant when the room is later cleaned up', async () => {
      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValueOnce([activeRoom])
      roomClient.listParticipants.mockResolvedValueOnce([participant('sid-1', Math.floor(now / 1000) - 60)])
      await (service as any).poll()

      // Left after a minute, room stays up for an hour, then disappears -> final flush must add nothing.
      roomClient.listRooms.mockResolvedValueOnce([activeRoom])
      roomClient.listParticipants.mockResolvedValueOnce([])
      dateSpy.mockReturnValue(now + 3_600_000)
      await (service as any).poll()

      const beforeCleanup = usageDeltas().reduce((sum, m) => sum + m.amount, 0)
      roomClient.listRooms.mockResolvedValueOnce([])
      await (service as any).poll()

      expect(usageDeltas().reduce((sum, m) => sum + m.amount, 0)).toBe(beforeCleanup)
      dateSpy.mockRestore()
    })

    it('flushes the remaining time for a participant still present at cleanup', async () => {
      const now = Date.now()
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
      roomClient.listRooms.mockResolvedValueOnce([activeRoom])
      roomClient.listParticipants.mockResolvedValue([participant('sid-1', Math.floor(now / 1000) - 60)])
      await (service as any).poll()

      dateSpy.mockReturnValue(now + 30_000)
      roomClient.listRooms.mockResolvedValueOnce([])
      await (service as any).poll()

      // 60s billed while polling, 30s remainder flushed when the room vanished.
      expect(usageDeltas().reduce((sum, m) => sum + m.amount, 0)).toBe(90)
      dateSpy.mockRestore()
    })
  })

  it('processRoom error for one room does not abort processing of other rooms', async () => {
    const otherMeetingId = 'meeting-2' as Ref<MeetingMinutes>
    const otherRoomName = `${workspace}_${otherMeetingId}`
    roomClient.listRooms.mockResolvedValue([
      { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }) },
      { name: otherRoomName, metadata: JSON.stringify({ projectKey: 'test-project' }) }
    ])
    roomClient.listParticipants.mockImplementation(async (name: string) => {
      if (name === roomName) throw new Error('listParticipants failed')
      return []
    })

    await (service as any).poll()

    // First room's listParticipants threw, but the second room's state must still be recorded.
    expect((service as any).roomStates.has(roomName)).toBe(false)
    expect((service as any).roomStates.has(otherRoomName)).toBe(true)
  })
})

describe('orphan egresses', () => {
  const GRACE_MS = 60_000
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: Record<string, jest.Mock>
  let egressClient: { listEgress: jest.Mock, stopEgress: jest.Mock }
  let service: LiveKitPollingService

  /** `startedAt` is nanoseconds in the LiveKit protocol. */
  const egress = (egressId: string, ageMs: number): any => ({
    egressId,
    roomName,
    startedAt: BigInt((Date.now() - ageMs) * 1_000_000)
  })

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    egressClient = { listEgress: jest.fn().mockResolvedValue([]), stopEgress: jest.fn().mockResolvedValue(undefined) }
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      { intervalMs: 1000, projectKey: 'test-project', ownerRejoinGraceMs: 15000 },
      undefined,
      egressClient as any
    )
    ;(service as any).isRunning = true
  })

  it('stops an egress no PendingRecording knows about', async () => {
    egressClient.listEgress.mockResolvedValue([egress('EG_orphan', GRACE_MS + 1000)])
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([])

    await (service as any).poll()

    expect(egressClient.stopEgress).toHaveBeenCalledWith('EG_orphan')
  })

  it('leaves a tracked egress alone', async () => {
    egressClient.listEgress.mockResolvedValue([egress('EG_tracked', GRACE_MS + 1000)])
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([{ _id: 'pr-1', egressId: 'EG_tracked' }])

    await (service as any).poll()

    expect(egressClient.stopEgress).not.toHaveBeenCalled()
  })

  it('leaves an egress alone while its reservation is still waiting for an egressId', async () => {
    egressClient.listEgress.mockResolvedValue([egress('EG_starting', GRACE_MS + 1000)])
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([{ _id: 'pr-1', startedAt: Date.now() - 1000 }])

    await (service as any).poll()

    expect(egressClient.stopEgress).not.toHaveBeenCalled()
  })

  it('keeps the egress when the lookup fails instead of reading it as untracked', async () => {
    egressClient.listEgress.mockResolvedValue([egress('EG_live', GRACE_MS + 1000)])
    wsClient.findPendingRecordingsByMeeting.mockRejectedValue(new Error('transactor down'))

    await (service as any).poll()

    expect(egressClient.stopEgress).not.toHaveBeenCalled()
  })

  it('keeps sweeping after one workspace fails', async () => {
    egressClient.listEgress.mockResolvedValue([
      {
        egressId: 'EG_broken',
        roomName: 'ws-a_meeting-a',
        startedAt: BigInt((Date.now() - GRACE_MS - 1000) * 1_000_000)
      },
      egress('EG_orphan2', GRACE_MS + 1000)
    ])
    wsClient.findPendingRecordingsByMeeting.mockRejectedValueOnce(new Error('workspace gone')).mockResolvedValue([])

    await (service as any).poll()

    expect(egressClient.stopEgress).toHaveBeenCalledTimes(1)
    expect(egressClient.stopEgress).toHaveBeenCalledWith('EG_orphan2')
  })

  it('leaves a fresh egress alone - its row may still be on the way', async () => {
    egressClient.listEgress.mockResolvedValue([egress('EG_fresh', 1000)])
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([])

    await (service as any).poll()

    expect(egressClient.stopEgress).not.toHaveBeenCalled()
  })
})

describe('participant seats wiped by a session restart', () => {
  const person = 'person-1' as Ref<Person>
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: Record<string, jest.Mock>
  let service: LiveKitPollingService

  async function poll (): Promise<void> {
    roomClient.listRooms.mockResolvedValue([
      { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }) }
    ])
    roomClient.listParticipants.mockResolvedValue([{ identity: person, sid: 'sid-1', kind: 0, name: 'Dirak' }])
    await (service as any).poll()
  }

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    wsClient.findPersonRefById.mockResolvedValue(person)
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      { intervalMs: 1000, projectKey: 'test-project', ownerRejoinGraceMs: 15000 },
      undefined
    )
    ;(service as any).isRunning = true
  })

  it('re-creates a seat that vanished from the database while LiveKit kept the participant', async () => {
    // First poll: the row is there, so the cache learns about the participant.
    wsClient.findParticipantInfosByMeeting.mockResolvedValue([
      { _id: 'pi-1', person, name: 'Dirak', sessionId: 'sid-1' }
    ])
    await poll()
    expect(wsClient.upsertParticipantFromLiveKit).not.toHaveBeenCalled()

    // The restart wipes DOMAIN_TRANSIENT; the cache still lists everyone.
    wsClient.findParticipantInfosByMeeting.mockResolvedValue([])
    await poll()

    expect(wsClient.upsertParticipantFromLiveKit).toHaveBeenCalledTimes(1)
  })
})

describe('office owner leaves', () => {
  const owner = 'person-owner' as Ref<Person>
  const guest = 'person-guest' as Ref<Person>
  const GRACE_MS = 15000
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: Record<string, jest.Mock>
  let service: LiveKitPollingService

  /** One poll cycle: `ownerLeftAt` is the stamp the webhook would have written. */
  async function pollWith (opts: { present: Array<Ref<Person>>, ownerLeftAt?: number }): Promise<void> {
    const metadata: Record<string, unknown> = { projectKey: 'test-project' }
    if (opts.ownerLeftAt !== undefined) metadata.ownerLeftAt = opts.ownerLeftAt
    roomClient.listRooms.mockResolvedValue([{ name: roomName, metadata: JSON.stringify(metadata) }])
    roomClient.listParticipants.mockResolvedValue(opts.present.map((identity, i) => ({ identity, sid: `sid-${i}` })))
    await (service as any).poll()
  }

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    wsClient.findOfficeOwner.mockResolvedValue(owner)
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      { intervalMs: 1000, projectKey: 'test-project', ownerRejoinGraceMs: GRACE_MS },
      undefined
    )
    ;(service as any).isRunning = true
  })

  it('leaves the room alone while nobody stamped a departure', async () => {
    await pollWith({ present: [guest] })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })

  it('keeps the room inside the grace period', async () => {
    await pollWith({ present: [guest], ownerLeftAt: Date.now() - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })

  it('closes the room once the owner has been gone past the grace', async () => {
    await pollWith({ present: [guest], ownerLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).toHaveBeenCalledWith(roomName)
  })

  it('clears the stamp and keeps the room when the owner is back', async () => {
    await pollWith({ present: [owner, guest], ownerLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
    expect(roomClient.updateRoomMetadata).toHaveBeenCalledWith(roomName, JSON.stringify({ projectKey: 'test-project' }))
  })

  it('leaves an empty room to LiveKit', async () => {
    await pollWith({ present: [], ownerLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })

  it('ignores a stamp on a room that is not an office', async () => {
    wsClient.findOfficeOwner.mockResolvedValue(undefined)

    await pollWith({ present: [guest], ownerLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })
})

describe('only the AI agent is left in the room', () => {
  const human = 'person-human' as Ref<Person>
  const GRACE_MS = 15000
  let roomClient: ReturnType<typeof createMockRoomClient>
  let wsClient: Record<string, jest.Mock>
  let service: LiveKitPollingService

  /** One poll cycle: `humans` join as regular participants, the AI bot as a `kind: 4` agent. */
  async function pollWith (opts: { humans: Array<Ref<Person>>, agent?: boolean, humansLeftAt?: number }): Promise<void> {
    const metadata: Record<string, unknown> = { projectKey: 'test-project' }
    if (opts.humansLeftAt !== undefined) metadata.humansLeftAt = opts.humansLeftAt
    roomClient.listRooms.mockResolvedValue([{ name: roomName, metadata: JSON.stringify(metadata) }])
    const participants: any[] = opts.humans.map((identity, i) => ({ identity, sid: `sid-${i}`, kind: 0 }))
    if (opts.agent !== false) {
      participants.push({ identity: 'ai-person', sid: 'sid-agent', kind: 4, permission: { agent: true } })
    }
    roomClient.listParticipants.mockResolvedValue(participants)
    await (service as any).poll()
  }

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    wsClient = createMockWsClient()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      { intervalMs: 1000, projectKey: 'test-project', ownerRejoinGraceMs: GRACE_MS },
      undefined
    )
    ;(service as any).isRunning = true
  })

  it('leaves the room alone while a human is still there', async () => {
    await pollWith({ humans: [human] })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
    expect(roomClient.updateRoomMetadata).not.toHaveBeenCalled()
  })

  it('stamps the departure on the first poll with the agent alone', async () => {
    await pollWith({ humans: [] })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
    const raw = roomClient.updateRoomMetadata.mock.calls[0]?.[1]
    expect(JSON.parse(raw).humansLeftAt).toEqual(expect.any(Number))
  })

  it('keeps the room inside the grace period', async () => {
    await pollWith({ humans: [], humansLeftAt: Date.now() - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })

  it('closes the room once the humans have been gone past the grace', async () => {
    await pollWith({ humans: [], humansLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).toHaveBeenCalledWith(roomName)
  })

  it('clears the stamp when a human comes back', async () => {
    await pollWith({ humans: [human], humansLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
    expect(roomClient.updateRoomMetadata).toHaveBeenCalledWith(roomName, JSON.stringify({ projectKey: 'test-project' }))
  })

  it('leaves a fully empty room to LiveKit', async () => {
    await pollWith({ humans: [], agent: false, humansLeftAt: Date.now() - GRACE_MS - 1000 })

    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })
})

describe('a room that has not had anyone in it yet', () => {
  const GRACE_MS = 15000
  let roomClient: ReturnType<typeof createMockRoomClient>
  let service: LiveKitPollingService

  /** `creationTime` is LiveKit's, in seconds. */
  async function pollWithRoomAge (ageMs: number): Promise<void> {
    const creationTime = Math.floor((Date.now() - ageMs) / 1000)
    roomClient.listRooms.mockResolvedValue([
      { name: roomName, metadata: JSON.stringify({ projectKey: 'test-project' }), creationTime }
    ])
    roomClient.listParticipants.mockResolvedValue([
      { identity: 'ai-person', sid: 'sid-agent', kind: 4, permission: { agent: true } }
    ])
    await (service as any).poll()
  }

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = createMockRoomClient()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(createMockWsClient())

    service = new LiveKitPollingService(
      createMockContext(),
      roomClient as any,
      { intervalMs: 1000, projectKey: 'test-project', ownerRejoinGraceMs: GRACE_MS },
      undefined
    )
    ;(service as any).isRunning = true
  })

  // The agent is dispatched at room creation, before the joiner's WebSocket is up.
  it('does not stamp a room younger than the grace', async () => {
    await pollWithRoomAge(2000)

    expect(roomClient.updateRoomMetadata).not.toHaveBeenCalled()
    expect(roomClient.deleteRoom).not.toHaveBeenCalled()
  })

  it('stamps once the room is older than the grace and nobody came', async () => {
    await pollWithRoomAge(GRACE_MS + 1000)

    const raw = roomClient.updateRoomMetadata.mock.calls[0]?.[1]
    expect(JSON.parse(raw).humansLeftAt).toEqual(expect.any(Number))
  })
})
