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
import core, { generateId, type Ref } from '@hcengineering/core'
import love, {
  buildMeetingLinkPayload,
  type MeetingMinutes,
  type PermanentMeeting,
  RoomType
} from '@hcengineering/love'
import { expect, test } from '@playwright/test'
import { PlatformSetting } from '../utils'
import {
  dropStaleMeetings,
  getMeetingsUser,
  getMeetingsWorkspace,
  getPlatformToken,
  getSystemRestClient,
  getSystemToken,
  loveEndpoint
} from './meeting-helpers'

const PERMANENT_NAMES = ['Design corner', 'Secret corner', 'Open corner']

async function createPermanentMeeting (name = 'Design corner'): Promise<{ _id: Ref<PermanentMeeting> }> {
  const { client, account } = await getMeetingsUser()
  const _id = generateId<PermanentMeeting>()
  await client.createDoc(
    love.class.PermanentMeeting,
    core.space.Space,
    {
      name,
      description: '',
      descriptionRef: null,
      type: RoomType.Video,
      language: 'en',
      startWithRecording: false,
      startWithTranscription: false,
      private: true,
      archived: false,
      members: [account],
      owners: [account]
    } as any,
    _id as any
  )
  return { _id }
}

async function resolveSession (id: string): Promise<{ status: number, body: any }> {
  const res = await fetch(`${loveEndpoint()}/resolveSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getPlatformToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: id, kind: 'meeting' })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function setPassword (id: string, password: string | null): Promise<number> {
  const res = await fetch(`${loveEndpoint()}/meetingPassword`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getPlatformToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: id, kind: 'meeting', password })
  })
  return res.status
}

async function guestCall (path: string, body: Record<string, any>): Promise<{ status: number, body: any }> {
  const res = await fetch(`${loveEndpoint()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function pointerFor (id: Ref<PermanentMeeting>): Promise<string> {
  return buildMeetingLinkPayload({
    eventId: id,
    workspace: await getMeetingsWorkspace(),
    linkVersion: 1,
    kind: 'meeting'
  })
}

export function registerPermanentMeetingTests (): void {
  test.describe('meeting minutes - permanent meetings', () => {
    test.use({ storageState: PlatformSetting })

    // Nothing in meetings-ws is cleaned up between runs; only this spec's own names are dropped.
    test.beforeAll(async () => {
      await dropStaleMeetings({ permanentMeetingNames: PERMANENT_NAMES })
    })

    test('a fresh permanent meeting has no session', async () => {
      const { _id } = await createPermanentMeeting()
      const sys = await getSystemRestClient()

      const sessions = await sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, { meeting: _id } as any)
      expect(sessions).toHaveLength(0)
    })

    test('opens at any hour, with no occurrence to wait for', async () => {
      const { _id } = await createPermanentMeeting()

      const { status, body } = await resolveSession(_id)

      expect(status).toBe(200)
      expect(typeof body.meetingId).toBe('string')
      // Unlike a series, nothing pins the session to a point in time.
      expect(body.occurrence).toBeUndefined()
    })

    test('a second join reuses the live session instead of opening another', async () => {
      const { _id } = await createPermanentMeeting()

      const first = await resolveSession(_id)
      const second = await resolveSession(_id)

      expect(second.body.meetingId).toBe(first.body.meetingId)

      const sys = await getSystemRestClient()
      const sessions = await sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, { meeting: _id } as any)
      expect(sessions).toHaveLength(1)
      // Neither kind of scheduled meeting occupies an ordinary room.
      expect(sessions[0].roomId).toBe(love.ids.ScheduledRoom)
    })

    test('an unknown id is not a meeting', async () => {
      const { status } = await resolveSession(generateId())
      expect(status).toBe(404)
    })

    test('the link is stable across calls', async () => {
      const { _id } = await createPermanentMeeting()

      const link = async (): Promise<any> => {
        const res = await fetch(`${loveEndpoint()}/meetingLink?eventId=${_id}&kind=meeting`, {
          headers: { Authorization: `Bearer ${await getSystemToken()}` }
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
      }

      const first = await link()
      expect(first.status).toBe(200)
      expect(typeof first.body.shortId).toBe('string')

      const second = await link()
      expect(second.body.shortId).toBe(first.body.shortId)
    })

    test('an empty guest password is refused', async () => {
      const { _id } = await createPermanentMeeting()
      // Hashing '' would open the link to anyone who sends ''.
      expect(await setPassword(_id, '')).toBe(400)
      expect(await setPassword(_id, '   ')).toBe(400)
    })

    test('a password hides everything the lobby would otherwise show', async () => {
      const { _id } = await createPermanentMeeting('Secret corner')
      expect(await setPassword(_id, 'sunny-otter-42')).toBe(200)

      const { status, body } = await guestCall('guestInfo', { token: await pointerFor(_id) })

      expect(status).toBe(200)
      expect(body.passwordRequired).toBe(true)
      expect(body.title).toBeUndefined()
      expect(body.meetingId).toBeUndefined()
      expect(body.nextOccurrence).toBeUndefined()
    })

    test('a guest with the wrong password is refused and opens no session', async () => {
      const { _id } = await createPermanentMeeting()
      expect(await setPassword(_id, 'sunny-otter-42')).toBe(200)

      const wrong = await guestCall('guestJoin', {
        token: await pointerFor(_id),
        firstName: 'Guest',
        lastName: 'One',
        password: 'nope'
      })
      expect(wrong.status).toBe(401)

      const sys = await getSystemRestClient()
      const sessions = await sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, { meeting: _id } as any)
      expect(sessions).toHaveLength(0)
    })

    test('removing the password opens the lobby again', async () => {
      const { _id } = await createPermanentMeeting('Open corner')
      expect(await setPassword(_id, 'sunny-otter-42')).toBe(200)
      expect(await setPassword(_id, null)).toBe(200)

      const { body } = await guestCall('guestInfo', { token: await pointerFor(_id) })

      expect(body.passwordRequired).toBeUndefined()
      expect(body.title).toBe('Open corner')
    })
  })
}
