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

import { type WorkspaceLoginInfo } from '@hcengineering/account-client'
import { RecordingState } from '@hcengineering/love'
import { RecordingProcessor } from '../recordings'
import { WorkspaceClient } from '../workspaceClient'
import { createMockContext, createMockMeeting, TEST_IDS } from './test-helpers'

jest.mock('../workspaceClient')
jest.mock('../storage', () => ({
  getS3UploadParams: jest.fn(async () => ({
    filepath: 'ws/file.mp4',
    endpoint: 'http://minio:9000',
    accessKey: 'k',
    secret: 's',
    region: 'auto',
    bucket: 'blobs'
  }))
}))
jest.mock('../config', () => ({
  __esModule: true,
  default: { RecordingPreset: 'H264_720P_30', UseEgressWebHook: false, WebHookUrl: '', ApiKey: 'key' }
}))

const roomName = 'ws_meeting'
const meeting = createMockMeeting()
const wsLoginInfo = {
  workspace: TEST_IDS.workspace,
  workspaceDataId: TEST_IDS.workspace,
  workspaceUrl: 'ws'
} as unknown as WorkspaceLoginInfo

/** Rows written by `createPendingRecording` come back from `findPendingRecordingsByMeeting`. */
function createMockWsClient (): Record<string, any> {
  const pending: any[] = []
  return {
    findMeetingById: jest.fn().mockResolvedValue(meeting),
    findPendingRecordingsByMeeting: jest.fn(async () => [...pending]),
    createPendingRecording: jest.fn(async (params: any) => {
      const id = `rec-${pending.length + 1}`
      pending.push({ ...params, _id: id, status: 'active', startedAt: Date.now() })
      return id
    }),
    setPendingRecordingEgressId: jest.fn(async (id: string, egressId: string) => {
      const row = pending.find((it) => it._id === id)
      if (row === undefined) return undefined
      row.egressId = egressId
      return row.status
    }),
    removePendingRecordingById: jest.fn(async (id: string) => {
      const idx = pending.findIndex((it) => it._id === id)
      if (idx >= 0) pending.splice(idx, 1)
    }),
    updateMeetingRecordingState: jest.fn().mockResolvedValue(undefined),
    cancelPendingRecording: jest.fn().mockResolvedValue(undefined),
    __pending: pending
  }
}

describe('RecordingProcessor.startRecording', () => {
  let roomClient: { listRooms: jest.Mock }
  let egressClient: { startRoomCompositeEgress: jest.Mock, stopEgress: jest.Mock }
  let eventProducer: { send: jest.Mock }
  let wsClient: Record<string, any>
  let processor: RecordingProcessor

  // The verdict contract these tests pin down.
  type StartVerdict = { started: true } | { started: false, reason: string }
  type StopVerdict = { stopped: true } | { stopped: false, reason: string }
  const verdict = (
    p: RecordingProcessor
  ): {
      startRecording: (...a: Parameters<RecordingProcessor['startRecording']>) => Promise<StartVerdict>
      stopRecording: (...a: Parameters<RecordingProcessor['stopRecording']>) => Promise<StopVerdict>
    } => p as never

  function createProcessor (): RecordingProcessor {
    return new RecordingProcessor(
      createMockContext(),
      roomClient as any,
      eventProducer as any,
      egressClient as any,
      { storages: [] } as any,
      undefined
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    roomClient = { listRooms: jest.fn().mockResolvedValue([{ name: roomName }]) }
    egressClient = {
      startRoomCompositeEgress: jest.fn().mockResolvedValue({ egressId: 'EG_1' }),
      stopEgress: jest.fn().mockResolvedValue(undefined)
    }
    eventProducer = { send: jest.fn().mockResolvedValue(undefined) }
    wsClient = createMockWsClient()
    ;(WorkspaceClient.create as jest.Mock).mockResolvedValue(wsClient)
    processor = createProcessor()
  })

  it('reserves before the egress call and attaches the egress id afterwards', async () => {
    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')

    expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(1)
    expect(wsClient.createPendingRecording).toHaveBeenCalledTimes(1)
    expect(wsClient.createPendingRecording.mock.calls[0][0]).toMatchObject({
      meeting: meeting._id,
      format: 'video'
    })
    // The reservation must be written first - that is what a second replica sees.
    expect(wsClient.createPendingRecording.mock.invocationCallOrder[0]).toBeLessThan(
      egressClient.startRoomCompositeEgress.mock.invocationCallOrder[0]
    )
    expect(wsClient.setPendingRecordingEgressId).toHaveBeenCalledWith('rec-1', 'EG_1')
    expect(wsClient.updateMeetingRecordingState).toHaveBeenCalledWith(meeting, RecordingState.Recording)
  })

  // The video path got the reservation guard in FUSIO-1242; the audio path (started by
  // `/transcription`) had none, so a second call produced a second egress of the same room.
  describe('startAudioRecording', () => {
    it('reserves before the egress call', async () => {
      await processor.startAudioRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo)

      expect(wsClient.createPendingRecording.mock.calls[0][0]).toMatchObject({ format: 'audio' })
      expect(wsClient.createPendingRecording.mock.invocationCallOrder[0]).toBeLessThan(
        egressClient.startRoomCompositeEgress.mock.invocationCallOrder[0]
      )
      expect(wsClient.setPendingRecordingEgressId).toHaveBeenCalledWith('rec-1', 'EG_1')
    })

    it('two concurrent starts produce a single egress', async () => {
      let release: (v: { egressId: string }) => void = () => {}
      const gate = new Promise<{ egressId: string }>((resolve) => {
        release = resolve
      })
      egressClient.startRoomCompositeEgress.mockImplementation(async () => await gate)

      const first = processor.startAudioRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo)
      while (egressClient.startRoomCompositeEgress.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const second = processor.startAudioRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo)
      release({ egressId: 'EG_1' })
      await Promise.all([first, second])

      expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(1)
      expect(wsClient.__pending.filter((it: any) => it.format === 'audio')).toHaveLength(1)
    })

    it('releases the reservation when the egress fails', async () => {
      egressClient.startRoomCompositeEgress.mockRejectedValueOnce(new Error('egress down'))

      await processor.startAudioRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo)
      expect(wsClient.__pending).toHaveLength(0)

      await processor.startAudioRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo)
      expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(2)
      expect(wsClient.__pending.filter((it: any) => it.format === 'audio')).toHaveLength(1)
    })
  })

  it('stops an egress that came up after the recording was cancelled', async () => {
    let release: (v: { egressId: string }) => void = () => {}
    egressClient.startRoomCompositeEgress.mockImplementation(
      async () =>
        await new Promise<{ egressId: string }>((resolve) => {
          release = resolve
        })
    )

    const started = processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')
    while (egressClient.startRoomCompositeEgress.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    // Stop pressed while the egress had no id yet - stopRecordingByKind only cancels the row.
    wsClient.__pending[0].status = 'cancelled'
    release({ egressId: 'EG_1' })
    await started

    expect(egressClient.stopEgress).toHaveBeenCalledWith('EG_1')
    expect(wsClient.updateMeetingRecordingState).not.toHaveBeenCalled()
  })

  it('releases the reservation so the next recording can start once the egress failed', async () => {
    egressClient.startRoomCompositeEgress.mockRejectedValueOnce(new Error('livekit down'))
    await expect(
      processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')
    ).rejects.toThrow('livekit down')
    expect(wsClient.removePendingRecordingById).toHaveBeenCalledWith('rec-1')

    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')
    expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(2)
    expect(wsClient.__pending).toHaveLength(1)
  })

  it('skips when a video recording already exists for the meeting', async () => {
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { format: 'video', status: 'active', egressId: 'EG_0', startedAt: Date.now() }
    ])

    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')

    expect(egressClient.startRoomCompositeEgress).not.toHaveBeenCalled()
    expect(wsClient.createPendingRecording).not.toHaveBeenCalled()
  })

  it('does nothing when the LiveKit room is gone', async () => {
    roomClient.listRooms.mockResolvedValue([])

    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')

    expect(egressClient.startRoomCompositeEgress).not.toHaveBeenCalled()
  })

  it('reports a refusal when a recording is already running (defect: /startRecord answers 200)', async () => {
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { format: 'video', status: 'active', egressId: 'EG_0', startedAt: Date.now() }
    ])

    // Must be a returned verdict, not a throw: auto-record calls this from the queue
    // consumer, where an exception triggers endless redelivery.
    const result = await verdict(processor).startRecording(
      roomName,
      TEST_IDS.workspace,
      meeting._id,
      wsLoginInfo,
      'All hands'
    )

    expect(result).toEqual({ started: false, reason: 'already-running' })
    expect(egressClient.startRoomCompositeEgress).not.toHaveBeenCalled()
  })

  it('repairs a meeting whose recordingState lags behind the live egress (defect: button stuck on start)', async () => {
    wsClient.findMeetingById.mockResolvedValue({ ...meeting, recordingState: RecordingState.NotStarted })
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { format: 'video', status: 'active', egressId: 'EG_0', startedAt: Date.now() }
    ])

    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')

    // Without this the client keeps reading `None`, renders a red button and routes every press
    // back into /startRecord -> 409 forever.
    expect(wsClient.updateMeetingRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ _id: meeting._id }),
      RecordingState.Recording
    )
  })

  it('two users pressing record at once start one egress and the loser is told (defect: read-then-create race)', async () => {
    let release: (v: { egressId: string }) => void = () => {}
    const gate = new Promise<{ egressId: string }>((resolve) => {
      release = resolve
    })
    egressClient.startRoomCompositeEgress.mockImplementation(async () => await gate)

    const both = Promise.all([
      verdict(processor).startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands'),
      verdict(processor).startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')
    ])
    await new Promise((resolve) => setImmediate(resolve))
    release({ egressId: 'EG_1' })
    const results = await both

    expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(1)
    expect(wsClient.createPendingRecording).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.started)).toHaveLength(1)
    expect(results.filter((r) => !r.started)).toEqual([{ started: false, reason: 'already-running' }])
  })

  it('refuses to stop a recording that started moments ago (defect: no cooldown on state flips)', async () => {
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { _id: 'rec-0', format: 'video', status: 'active', egressId: 'EG_0', startedAt: Date.now() - 500 }
    ])

    const result = await verdict(processor).stopRecording(roomName, TEST_IDS.workspace, meeting._id)

    expect(result).toEqual({ stopped: false, reason: 'cooldown' })
    expect(egressClient.stopEgress).not.toHaveBeenCalled()
  })

  it('allows the stop once the cooldown has passed', async () => {
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { _id: 'rec-0', format: 'video', status: 'active', egressId: 'EG_0', startedAt: Date.now() - 10_000 }
    ])

    const result = await verdict(processor).stopRecording(roomName, TEST_IDS.workspace, meeting._id)

    expect(result).toEqual({ stopped: true })
    expect(egressClient.stopEgress).toHaveBeenCalledWith('EG_0')
  })

  it('does not let a stale reservation without an egress id block a new recording (defect: stuck PendingRecording)', async () => {
    // Reservation from a process that died between createPendingRecording and the egress
    // call: no egress_ended will ever arrive to clear it.
    wsClient.findPendingRecordingsByMeeting.mockResolvedValue([
      { format: 'video', status: 'active', egressId: undefined, startedAt: Date.now() - 60 * 60 * 1000 }
    ])

    await processor.startRecording(roomName, TEST_IDS.workspace, meeting._id, wsLoginInfo, 'All hands')

    expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(1)
    expect(wsClient.createPendingRecording).toHaveBeenCalledTimes(1)
  })
})
