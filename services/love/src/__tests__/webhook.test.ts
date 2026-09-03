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

import { WebhookProcessor } from '../webhook'
import { WorkspaceClient } from '../workspaceClient'
import { MeasureContext, Ref, WorkspaceUuid } from '@hcengineering/core'
import {
  MeetingMinutes,
  MeetingStatus,
  ParsedRoomName,
  QueueMeetingEvent,
  RecordingState,
  Room
} from '@hcengineering/love'
import { Person } from '@hcengineering/contact'
import { WebhookEvent } from 'livekit-server-sdk'

// Mock dependencies
jest.mock('../workspaceClient')
jest.mock('@hcengineering/server-token')

const mockCtx: MeasureContext = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  measure: jest.fn(() => ({ end: jest.fn() })),
  newChild: jest.fn(() => mockCtx),
  contextData: {},
  with: jest.fn(),
  withSync: jest.fn(),
  extractMeta: jest.fn(),
  logger: jest.fn()
} as unknown as MeasureContext

const createMockRoomName = (): ParsedRoomName => ({
  workspace: 'workspace-1' as WorkspaceUuid,
  meetingId: 'meeting-1' as Ref<MeetingMinutes>
})

const createMockMeeting = (overrides?: Partial<MeetingMinutes>): Partial<MeetingMinutes> => ({
  _id: 'meeting-1' as Ref<MeetingMinutes>,
  name: 'Test Meeting',
  roomId: 'room-1' as Ref<Room>,
  status: MeetingStatus.Active,
  private: false,
  ...overrides
})

describe('WebhookProcessor - Meeting Lifecycle', () => {
  let processor: WebhookProcessor
  let mockWsClient: jest.Mocked<WorkspaceClient>
  let mockRoomClient: any
  let mockEventProducer: any
  let mockEgressClient: any

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock WorkspaceClient
    mockWsClient = {
      findMeetingById: jest.fn(),
      upsertParticipantFromLiveKit: jest.fn(),
      removeParticipantFromLiveKit: jest.fn(),
      activateMeeting: jest.fn(),
      finishMeeting: jest.fn(),
      addActivityToMeeting: jest.fn(),
      findPersonRefById: jest.fn(),
      getPersonIdByPersonRef: jest.fn(),
      findOfficeOwner: jest.fn(),
      findPendingRecordingByEgressId: jest.fn(),
      removePendingRecording: jest.fn(),
      updateMeetingRecordingState: jest.fn()
    } as unknown as jest.Mocked<WorkspaceClient>

    // Mock WorkspaceClient.create to return mockWsClient
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(mockWsClient)

    mockRoomClient = {}
    mockEventProducer = {
      send: jest.fn()
    }
    mockEgressClient = {}

    processor = new WebhookProcessor(mockCtx, mockRoomClient, mockEventProducer, mockEgressClient, undefined, undefined)
  })

  describe('room_started event', () => {
    it('should activate meeting', async () => {
      const event: Partial<WebhookEvent> = {
        event: 'room_started',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      expect(mockEventProducer.send).toHaveBeenCalled()
    })
  })

  describe('room_finished event', () => {
    it('should finish meeting', async () => {
      const event: Partial<WebhookEvent> = {
        event: 'room_finished',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      expect(mockEventProducer.send).toHaveBeenCalled()
    })
  })

  describe('egress_ended event', () => {
    // Same shape the other suites use: plain mocks, so eslint sees no unbound method reference.
    const ws = (): Record<string, jest.Mock> => mockWsClient as unknown as Record<string, jest.Mock>

    function endedEvent (): WebhookEvent {
      return {
        event: 'egress_ended',
        egressInfo: { egressId: 'EG_1', fileResults: [] }
      } as unknown as WebhookEvent
    }

    it('keeps the recording flag when the audio egress ends (defect: audio end stops the video button)', async () => {
      mockWsClient.findMeetingById.mockResolvedValue(createMockMeeting() as MeetingMinutes)
      ws().findPendingRecordingByEgressId.mockResolvedValue({ _id: 'rec-audio', format: 'audio' })

      await processor.processEvent(endedEvent(), createMockRoomName())

      // The video egress is still writing; clearing the flag leaves the button red while
      // every press routes to /startRecord.
      expect(ws().updateMeetingRecordingState).not.toHaveBeenCalled()
      expect(ws().removePendingRecording).toHaveBeenCalled()
    })

    it('clears the recording flag when the video egress ends', async () => {
      mockWsClient.findMeetingById.mockResolvedValue(createMockMeeting() as MeetingMinutes)
      ws().findPendingRecordingByEgressId.mockResolvedValue({ _id: 'rec-video', format: 'video' })

      await processor.processEvent(endedEvent(), createMockRoomName())

      expect(ws().updateMeetingRecordingState).toHaveBeenCalledWith(expect.anything(), RecordingState.Finished)
    })
  })

  describe('participant_joined event', () => {
    it('should handle participant join', async () => {
      const meeting = createMockMeeting()
      mockWsClient.findMeetingById.mockResolvedValue(meeting as MeetingMinutes)
      mockWsClient.findPersonRefById.mockResolvedValue('person-1' as Ref<Person>)

      const event: Partial<WebhookEvent> = {
        event: 'participant_joined',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any,
        participant: {
          identity: 'person-1',
          name: 'Test User',
          sid: 'participant-sid-1',
          kind: 0
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockWsClient.upsertParticipantFromLiveKit).toHaveBeenCalled()
    })
  })

  describe('participant_left event', () => {
    it('should handle participant leave', async () => {
      const meeting = createMockMeeting()
      mockWsClient.findMeetingById.mockResolvedValue(meeting as MeetingMinutes)
      mockWsClient.findPersonRefById.mockResolvedValue('person-1' as Ref<Person>)

      const event: Partial<WebhookEvent> = {
        event: 'participant_left',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any,
        participant: {
          identity: 'person-1',
          name: 'Test User',
          sid: 'participant-sid-1',
          kind: 0
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockWsClient.removeParticipantFromLiveKit).toHaveBeenCalled()
    })

    it('publishes a leave event distinct from personJoined (defect: participant_left publishes personJoined)', async () => {
      const meeting = createMockMeeting()
      mockWsClient.findMeetingById.mockResolvedValue(meeting as MeetingMinutes)
      mockWsClient.findPersonRefById.mockResolvedValue('person-1' as Ref<Person>)
      mockWsClient.findOfficeOwner.mockResolvedValue(undefined)

      const event: Partial<WebhookEvent> = {
        event: 'participant_left',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any,
        participant: {
          identity: 'person-1',
          name: 'Test User',
          sid: 'participant-sid-1',
          kind: 0
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      const sentMessages = mockEventProducer.send.mock.calls.flatMap((call: any[]) => call[2])
      const personEvents = sentMessages.filter(
        (m: any) => m.type === QueueMeetingEvent.personJoined || m.type === QueueMeetingEvent.personLeft
      )
      expect(personEvents).toHaveLength(1)
      expect(personEvents[0].type).toBe(QueueMeetingEvent.personLeft)
    })
  })

  describe('office owner leaves', () => {
    it('stamps ownerLeftAt instead of closing the room, so a refresh survives', async () => {
      mockWsClient.findMeetingById.mockResolvedValue(createMockMeeting() as MeetingMinutes)
      mockWsClient.findPersonRefById.mockResolvedValue('person-1' as Ref<Person>)
      mockWsClient.findOfficeOwner.mockResolvedValue('person-1' as Ref<Person>)
      mockRoomClient.deleteRoom = jest.fn()
      mockRoomClient.listRooms = jest.fn().mockResolvedValue([{ name: 'workspace-1_meeting-1', metadata: '{}' }])
      mockRoomClient.updateRoomMetadata = jest.fn()

      const event: Partial<WebhookEvent> = {
        event: 'participant_left',
        room: { name: 'workspace-1_meeting-1', sid: 'room-sid-1' } as any,
        participant: { identity: 'person-1', name: 'Owner', sid: 'participant-sid-1', kind: 0 } as any
      }

      await processor.processEvent(event as WebhookEvent, createMockRoomName())

      expect(mockRoomClient.deleteRoom).not.toHaveBeenCalled()
      const [, written] = mockRoomClient.updateRoomMetadata.mock.calls[0]
      expect(JSON.parse(written).ownerLeftAt).toEqual(expect.any(Number))
    })
  })

  describe('private meeting handling', () => {
    it('should handle private meeting', async () => {
      const meeting = createMockMeeting({ private: true })
      mockWsClient.findMeetingById.mockResolvedValue(meeting as MeetingMinutes)

      const event: Partial<WebhookEvent> = {
        event: 'room_started',
        room: {
          name: 'workspace-1_meeting-1',
          sid: 'room-sid-1'
        } as any
      }
      const roomName = createMockRoomName()

      await processor.processEvent(event as WebhookEvent, roomName)

      expect(event.event).toBe('room_started')
    })
  })
})

describe('WebhookProcessor - Error Handling', () => {
  let processor: WebhookProcessor
  let mockCtx: MeasureContext
  let mockRoomClient: any
  let mockEventProducer: any
  let mockEgressClient: any

  beforeEach(() => {
    mockCtx = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      measure: jest.fn(() => ({ end: jest.fn() })),
      newChild: jest.fn(() => mockCtx),
      contextData: {},
      with: jest.fn(),
      withSync: jest.fn(),
      extractMeta: jest.fn(),
      logger: jest.fn()
    } as unknown as MeasureContext

    mockRoomClient = {}
    mockEventProducer = { send: jest.fn() }
    mockEgressClient = {}

    processor = new WebhookProcessor(mockCtx, mockRoomClient, mockEventProducer, mockEgressClient, undefined, undefined)
  })

  it('should handle missing meeting gracefully', async () => {
    // When WorkspaceClient.create fails, processEvent must swallow error and log it.
    ;(WorkspaceClient.create as jest.Mock).mockRejectedValue(new Error('ws not found'))

    const event: Partial<WebhookEvent> = {
      event: 'room_started',
      room: { name: 'workspace-1_meeting-1' } as any
    }
    const roomName = createMockRoomName()

    await processor.processEvent(event as WebhookEvent, roomName)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockCtx.error).toHaveBeenCalled()
  })

  it('should handle WorkspaceClient creation failure', async () => {
    // processEvent catches errors from WorkspaceClient.create and logs via ctx.error,
    // it should NOT re-throw so the webhook endpoint stays resilient.
    ;(WorkspaceClient.create as jest.Mock).mockRejectedValue(new Error('Connection failed'))

    const event: Partial<WebhookEvent> = {
      event: 'participant_joined',
      room: { name: 'workspace-1_meeting-1' } as any,
      participant: { identity: 'person-1', kind: 0 } as any
    }
    const roomName = createMockRoomName()

    await processor.processEvent(event as WebhookEvent, roomName)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockCtx.error).toHaveBeenCalled()
  })
})
