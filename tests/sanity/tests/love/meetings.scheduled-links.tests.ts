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

import { createRestClient, getWorkspaceToken, loadServerConfig, type RestClient } from '@hcengineering/api-client'
import { generateId, type Ref, type Space } from '@hcengineering/core'
import love, {
  MeetingStatus,
  RecordingState,
  TranscriptionState,
  type MeetingMinutes,
  type Room
} from '@hcengineering/love'
import { expect, test, type Page } from '@playwright/test'
import { PlatformURI, PlatformUserSecond } from '../utils'
import { retry, retryIntervals } from '../retry'
import {
  connectedMarker,
  clickRoomByName,
  roomPanelConnect,
  closeMeetingContexts,
  getSystemRestClient,
  loveWindow,
  openLove,
  waitConnected,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

const meetingsWs = 'meetings-ws'

async function getMeetingsRestClient (): Promise<RestClient> {
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: meetingsWs },
    config
  )
  return createRestClient(token.endpoint, token.workspaceId, token.token)
}

// Same doc shape as love-resources createMeeting() from Calendar; built via REST (Calendar UI has no test selectors).
async function createScheduledMeeting (
  client: RestClient,
  roomName: string,
  scheduledInMs: number
): Promise<Ref<MeetingMinutes>> {
  const room = await client.findOne<Room>(love.class.Room, { name: roomName })
  if (room === undefined) throw new Error(`Room not found: ${roomName}`)
  const account = await client.getAccount()

  // Finish leftovers: EditRoom connect() picks the first non-Finished meeting for the room.
  const sys = await getSystemRestClient()
  const leftovers = await sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, {
    roomId: room._id,
    status: { $ne: MeetingStatus.Finished }
  })
  await Promise.all(
    leftovers.map((m) =>
      sys
        .updateDoc(love.class.MeetingMinutes, m.space, m._id, { status: MeetingStatus.Finished })
        .catch(() => undefined)
    )
  )

  const id = generateId<MeetingMinutes>()
  await client.createDoc(
    love.class.MeetingMinutes,
    id as unknown as Ref<Space>,
    {
      name: `Scheduled Test Meeting ${id}`,
      description: '',
      private: false,
      archived: false,
      members: [account.uuid],
      owners: [account.uuid],
      descriptionRef: null,
      summary: null,
      roomId: room._id,
      status: MeetingStatus.Scheduled,
      language: 'en',
      recordingState: RecordingState.NotStarted,
      transcriptionState: TranscriptionState.NotStarted,
      meetingScheduledDate: Date.now() + scheduledInMs
    },
    id
  )
  return id
}

async function getGuestUrlViaApi (client: RestClient, meetingId: Ref<MeetingMinutes>): Promise<string> {
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: meetingsWs },
    config
  )
  // ServerConfig type omits LOVE_ENDPOINT, but /config.json spreads it (front extraConfig).
  const loveEndpoint = (config as unknown as { LOVE_ENDPOINT: string }).LOVE_ENDPOINT
  const res = await fetch(`${loveEndpoint.replace(/\/$/, '')}/guestToken`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ meetingId })
  })
  expect(res.ok, `guestToken request failed: ${res.status}`).toBeTruthy()
  const data = await res.json()
  const shortIdOrToken: string = data?.token ?? data
  const isShortId = !shortIdOrToken.includes('.')
  const front = (PlatformURI ?? '').replace(/\/$/, '')
  return isShortId ? `${front}/meetings/${shortIdOrToken}` : `${front}/meetings?guestToken=${shortIdOrToken}`
}

// Retried with the room click: the panel can render Knock instead of Connect while the previous
// meeting is still being cleaned up, and re-opening the room is what settles it.
async function startMeeting (page: Page, room: string): Promise<void> {
  await retry(async () => {
    await clickRoomByName(page, room)
    const connect = roomPanelConnect(page)
    // Connect is hidden while we are in that very room, and then there is nothing left to do.
    if (!(await connect.isVisible().catch(() => false)) && (await connectedMarker(page).count()) > 0) return
    await expect(connect).toBeVisible({ timeout: 10000 })
    await connect.click({ timeout: 10000 })
  }, 30000)
}

export function registerScheduledLinksTests (): void {
  test.describe('meeting minutes - scheduled meeting lifecycle', () => {
    test.beforeEach(async () => {
      await waitForActiveMeetingsToFinish()
    })

    test('guest link is stable across repeated requests', async () => {
      const client = await getMeetingsRestClient()
      const meetingId = await createScheduledMeeting(client, 'Meeting Room 2', 30 * 60 * 1000)

      const first = await getGuestUrlViaApi(client, meetingId)
      const second = await getGuestUrlViaApi(client, meetingId)

      expect(first).not.toBe('')
      expect(first).toBe(second)
    })

    test('aborted early start does not kill scheduled meeting', async ({ browser }) => {
      test.setTimeout(90000)
      const client = await getMeetingsRestClient()
      // Schedule far enough in the future that it stays > Date.now() through the whole test.
      const meetingId = await createScheduledMeeting(client, 'Meeting Room 1', 60 * 60 * 1000)

      // Same account as the REST client above (PlatformUserSecond).
      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        await startMeeting(page, 'Meeting Room 1')
        await waitConnected(page)

        // Leave: room_finished webhook must re-arm the future-dated meeting to Scheduled.
        await page.locator('[data-id="meeting-leave"]').first().click()
        await expect(page.locator('[data-id="meeting-widget"]')).toBeHidden({ timeout: 15000 })

        await expect
          .poll(
            async () => {
              const mm = await client.findOne<MeetingMinutes>(love.class.MeetingMinutes, { _id: meetingId })
              return mm?.status
            },
            { timeout: 60000, intervals: retryIntervals }
          )
          .toBe(MeetingStatus.Scheduled)

        // Re-open and confirm it is joinable again (not stuck Finished).
        await openLove(page)
        await startMeeting(page, 'Meeting Room 1')
        await waitConnected(page)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('scheduled meeting survives a poll cycle', async () => {
      test.setTimeout(60000)
      const client = await getMeetingsRestClient()
      const meetingId = await createScheduledMeeting(client, 'Voice only room', 60 * 60 * 1000)

      // Wait past one polling cycle (10s) and assert `checkUnfinishedMeetings` did not
      // force-finish the meeting.
      await new Promise((resolve) => setTimeout(resolve, 14000))

      const mm = await client.findOne<MeetingMinutes>(love.class.MeetingMinutes, { _id: meetingId })
      expect(mm?.status).toBe(MeetingStatus.Scheduled)
    })
  })
}
