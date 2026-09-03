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

// API-level test, no browser. Lives here rather than ws-tests: that stand has no love
// service or `_love` proxy at all.

import { expect, test } from '@playwright/test'
import { generateId, type Ref, type Space } from '@hcengineering/core'
import { getWorkspaceToken, loadServerConfig } from '@hcengineering/api-client'
import love, { MeetingStatus, RecordingState, TranscriptionState, type MeetingMinutes } from '@hcengineering/love'
import { PlatformURI, PlatformUserSecond } from '../utils'
import { getMeetingsUser, getSystemRestClient, waitForActiveMeetingsToFinish } from './meeting-helpers'

const MEETINGS_WS = 'meetings-ws'

/** Raw workspace JWT for PlatformUserSecond — same token the browser client sends
 *  as `Authorization: Bearer` to `/getToken` (plugins/love-resources/src/loveClient.ts). */
async function getPlatformToken (): Promise<string> {
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: MEETINGS_WS },
    config
  )
  return token.token
}

export function registerFinishedTokenTests (): void {
  test.describe('meeting minutes - getToken vs meeting status', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    // Defect: /getToken checks `private` + membership but never `status`, so a Finished
    // meeting still gets a token and a recreated LiveKit room.
    test('POST /getToken rejects a Finished meeting (defect: status is never checked)', async () => {
      const sys = await getSystemRestClient()
      const { account } = await getMeetingsUser()

      const meetingId = generateId<MeetingMinutes>()
      try {
        await sys.createDoc(
          love.class.MeetingMinutes,
          meetingId as unknown as Ref<Space>,
          {
            name: 'defect-c finished meeting',
            description: '',
            private: false,
            archived: false,
            members: [account],
            owners: [account],
            descriptionRef: null,
            summary: null,
            status: MeetingStatus.Finished,
            meetingEnd: Date.now() - 60_000,
            transcriptionState: TranscriptionState.NotStarted,
            recordingState: RecordingState.NotStarted,
            language: 'en'
          },
          meetingId
        )

        const token = await getPlatformToken()
        const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
        const res = await fetch(`${baseUrl}/_love/getToken`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId, _id: account, participantName: 'defect-c-tester' })
        })

        // Currently responds 200 with a live LiveKit token — should be 409/410.
        expect([409, 410]).toContain(res.status)
      } finally {
        await sys
          .removeDoc(love.class.MeetingMinutes, meetingId as unknown as Ref<Space>, meetingId)
          .catch(() => undefined)
      }
    })
  })
}
