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

import { expect, test, type Page } from '@playwright/test'
import love, {
  RecordingState,
  TranscriptionState,
  type MeetingMinutes,
  type PendingRecording,
  type RecordingFormat
} from '@hcengineering/love'
import type { Ref } from '@hcengineering/core'
import {
  closeMeetingContexts,
  firstAvailableRoom,
  getPlatformToken,
  getSystemRestClient,
  joinRoom,
  loveEndpoint,
  loveWindow,
  openLove,
  waitForActiveMeetingsToFinish,
  waitRoomMeeting
} from './meeting-helpers'

/** Egress needs a real LiveKit room and an S3 round-trip, so give it room to breathe. */
const EGRESS_TIMEOUT = 60000
/** `/stopRecord` refuses inside `RecordingProcessor.STATE_FLIP_COOLDOWN_MS` (3s). */
const STOP_COOLDOWN_MS = 3500

// Transcription runs its own audio egress with its own PendingRecording, so the video tests
// must count only their own format.
async function activeRecordings (
  meetingId: Ref<MeetingMinutes>,
  format: RecordingFormat = 'video'
): Promise<PendingRecording[]> {
  const sys = await getSystemRestClient()
  const all = await sys.findAll<PendingRecording>(love.class.PendingRecording, { attachedTo: meetingId })
  return all.filter((it) => it.status === 'active' && it.format === format)
}

async function meetingState (meetingId: Ref<MeetingMinutes>): Promise<MeetingMinutes | undefined> {
  const sys = await getSystemRestClient()
  return await sys.findOne<MeetingMinutes>(love.class.MeetingMinutes, { _id: meetingId })
}

function recordButton (page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-id="recording-button"]').locator('visible=true').first()
}

export function registerRecordingTests (): void {
  test.describe('meeting minutes - recording and transcription', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    test('recording start writes a PendingRecording and a plate, stop clears both', async ({ browser }) => {
      test.setTimeout(180000)

      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        const roomName = await firstAvailableRoom(page)
        test.skip(roomName === null, 'No regular room available')
        await joinRoom(page, roomName as string)

        const meeting = await waitRoomMeeting(roomName as string)
        const button = recordButton(page)
        // The button only renders when the service reports storage configured (`/checkRecordAvailable`).
        test.skip((await button.count()) === 0, 'Recording is not configured on this stand')

        await button.click()

        await expect.poll(async () => (await activeRecordings(meeting._id)).length, { timeout: EGRESS_TIMEOUT }).toBe(1)
        await expect(page.locator('[data-id="pending-recording"]').first()).toBeVisible({ timeout: 15000 })
        await expect
          .poll(async () => (await meetingState(meeting._id))?.recordingState, { timeout: 15000 })
          .toBe(RecordingState.Recording)

        await page.waitForTimeout(STOP_COOLDOWN_MS)
        await button.click()

        await expect.poll(async () => (await activeRecordings(meeting._id)).length, { timeout: EGRESS_TIMEOUT }).toBe(0)
        await expect
          .poll(async () => (await meetingState(meeting._id))?.recordingState, { timeout: EGRESS_TIMEOUT })
          .toBe(RecordingState.Finished)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    // D18: the guard used to be a check-then-act around an egress call that takes seconds,
    // so two presses landed two recordings of the same room.
    test('two concurrent /startRecord calls produce a single recording', async ({ browser }) => {
      test.setTimeout(180000)

      const { ctx, page } = await loveWindow(browser, 'second')
      let meeting: MeetingMinutes | undefined
      try {
        await openLove(page)
        const roomName = await firstAvailableRoom(page)
        test.skip(roomName === null, 'No regular room available')
        await joinRoom(page, roomName as string)

        meeting = await waitRoomMeeting(roomName as string)
        // Gate on the service, not on the button: this test never touches the UI control.
        const available = await (await fetch(`${loveEndpoint()}/checkRecordAvailable`)).json()
        test.skip(available !== true, 'Recording is not configured on this stand')

        const token = await getPlatformToken()
        const start = async (): Promise<number> => {
          const res = await fetch(`${loveEndpoint()}/startRecord`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ meetingId: meeting?._id, name: 'double-click test' })
          })
          return res.status
        }
        const [first, second] = await Promise.all([start(), start()])

        expect([first, second].filter((s) => s === 200)).toHaveLength(1)
        expect([first, second].filter((s) => s === 409)).toHaveLength(1)
        await expect
          .poll(async () => (await activeRecordings(meeting?._id as Ref<MeetingMinutes>)).length, {
            timeout: EGRESS_TIMEOUT
          })
          .toBe(1)
      } finally {
        if (meeting !== undefined) {
          const token = await getPlatformToken()
          await fetch(`${loveEndpoint()}/stopRecord`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ meetingId: meeting._id })
          }).catch(() => undefined)
        }
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    // D20: `transcriptionState` used to be written only by ai-bot, so without a bot the
    // button never flipped and stopping was unreachable.
    test('transcription toggle flips transcriptionState both ways', async ({ browser }) => {
      test.setTimeout(120000)

      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        const roomName = await firstAvailableRoom(page)
        test.skip(roomName === null, 'No regular room available')
        await joinRoom(page, roomName as string)

        const meeting = await waitRoomMeeting(roomName as string)

        // Straight at love's endpoint: the button routes through ai-bot, whose transcription
        // provider is not deployed on the stand, and that has nothing to do with what is asserted.
        const token = await getPlatformToken()
        const transcription = async (on: boolean): Promise<number> => {
          const res = await fetch(`${loveEndpoint()}/transcription`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ meetingId: meeting._id, transcription: on })
          })
          return res.status
        }

        expect(await transcription(true)).toBe(200)
        await expect
          .poll(async () => (await meetingState(meeting._id))?.transcriptionState, { timeout: 30000 })
          .toBe(TranscriptionState.Transcribing)
        // Transcription starts an audio egress; it must stay a single one per meeting.
        await expect
          .poll(async () => (await activeRecordings(meeting._id, 'audio')).length, { timeout: EGRESS_TIMEOUT })
          .toBe(1)

        await page.waitForTimeout(STOP_COOLDOWN_MS)
        expect(await transcription(false)).toBe(200)
        await expect
          .poll(async () => (await meetingState(meeting._id))?.transcriptionState, { timeout: 30000 })
          .toBe(TranscriptionState.Finished)
        await expect
          .poll(async () => (await activeRecordings(meeting._id, 'audio')).length, { timeout: EGRESS_TIMEOUT })
          .toBe(0)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })
  })
}
