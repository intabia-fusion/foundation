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

import { expect, test } from '@playwright/test'
import { generateId, type Ref, type Space } from '@hcengineering/core'
import love, {
  MeetingStatus,
  RecordingState,
  TranscriptionState,
  type MeetingMinutes,
  type Room
} from '@hcengineering/love'
import {
  closeMeetingContexts,
  firstAvailableRoom,
  getSystemRestClient,
  joinRoom,
  loveWindow,
  openLove,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

export function registerScheduledConnectTests (): void {
  test.describe('meeting minutes - connect vs scheduled meeting', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    // Defect: `EditRoom.connect` picks any meeting of the room from an unordered store,
    // including a future Scheduled one, and `room_started` then flips it to Active.
    test('Connect starts a new meeting instead of joining a future Scheduled one (defect: EditRoom picks any meeting)', async ({
      browser
    }) => {
      test.setTimeout(60000)

      const { ctx, page } = await loveWindow(browser, 'second')
      const sys = await getSystemRestClient()
      let scheduledId: Ref<MeetingMinutes> | undefined

      try {
        await openLove(page)

        const roomName = await firstAvailableRoom(page)
        test.skip(roomName === null, 'No regular room available')

        const room = await sys.findOne(love.class.Room, { name: roomName as string })
        expect(room).toBeDefined()

        scheduledId = generateId<MeetingMinutes>()
        await sys.createDoc(
          love.class.MeetingMinutes,
          scheduledId as unknown as Ref<Space>,
          {
            name: 'Next week planning',
            description: '',
            private: false,
            archived: false,
            members: [],
            owners: [],
            descriptionRef: null,
            summary: null,
            roomId: (room as Room)._id,
            status: MeetingStatus.Scheduled,
            meetingScheduledDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
            transcriptionState: TranscriptionState.NotStarted,
            recordingState: RecordingState.NotStarted,
            language: 'en'
          },
          scheduledId
        )

        await joinRoom(page, roomName as string)

        // Connect must start a fresh ad-hoc meeting and leave the Scheduled one untouched.
        const scheduledAfter = await sys.findOne(love.class.MeetingMinutes, { _id: scheduledId })
        expect(scheduledAfter?.status).toBe(MeetingStatus.Scheduled)
      } finally {
        if (scheduledId !== undefined) {
          await sys
            .removeDoc(love.class.MeetingMinutes, scheduledId as unknown as Ref<Space>, scheduledId)
            .catch(() => undefined)
        }
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })
  })
}
