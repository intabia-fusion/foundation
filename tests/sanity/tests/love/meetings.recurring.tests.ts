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
import calendar, { AccessLevel, generateEventId, type Event } from '@hcengineering/calendar'
import contact from '@hcengineering/contact'
import { generateId, type Ref, type Space } from '@hcengineering/core'
import love, { defaultMeetingAccess, type MeetingMinutes, RoomType } from '@hcengineering/love'
import { expect, test } from '@playwright/test'
import { PlatformSetting } from '../utils'
import {
  dropStaleMeetings,
  getMeetingsUser,
  getPlatformToken,
  getSystemRestClient,
  getSystemToken,
  loveEndpoint
} from './meeting-helpers'

const SERIES_TITLE = 'Recurring sanity '
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * A scheduled meeting the way the calendar creates one: a master event carrying the mixin, and
 * no session at all - the love service opens that when an occurrence comes.
 */
async function createSeries (opts: { startsIn: number, weekly: boolean }): Promise<{ eventId: string }> {
  const { client, account } = await getMeetingsUser()
  const eventId = generateEventId()
  const date = Date.now() + opts.startsIn
  const _id = generateId<Event>()

  // A link is only issued to a participant, so the author has to be one.
  const me = await client.findOne(contact.class.Person, { personUuid: account as any })
  // Filtered: meetings-ws holds three accounts, and an unfiltered findOne picks any of them.
  const personSpace = await client.findOne(contact.class.PersonSpace, { account })
  // Older backups keep calendars in the system space, so prefer this account's own and fall back.
  const cal =
    (personSpace !== undefined
      ? await client.findOne(calendar.class.Calendar, { space: personSpace._id })
      : undefined) ?? (await client.findOne(calendar.class.Calendar, {}))
  const space = (personSpace?._id ?? cal?.space) as unknown as Ref<Space>

  // Event is an AttachedDoc - createDoc is refused for those.
  await client.addCollection(
    opts.weekly ? calendar.class.ReccuringEvent : calendar.class.Event,
    space,
    calendar.ids.NoAttached,
    calendar.class.Event,
    'events',
    {
      eventId,
      date,
      dueDate: date + HOUR,
      allDay: false,
      title: `${SERIES_TITLE}${eventId.slice(0, 6)}`,
      description: '',
      participants: me !== undefined ? [me._id] : [],
      reminders: [],
      visibility: 'public',
      access: AccessLevel.Owner,
      blockTime: true,
      calendar: cal?._id as any,
      user: account as any,
      ...(opts.weekly
        ? { rules: [{ freq: 'WEEKLY', interval: 1 }], rdate: [], exdate: [], originalStartTime: date }
        : {})
    } as any,
    _id as any
  )

  await client.createMixin(_id as any, calendar.class.Event, space, love.mixin.MeetingEventLink, {
    type: RoomType.Video,
    linkVersion: 1,
    meetingAccess: defaultMeetingAccess,
    private: false,
    language: 'en',
    startWithRecording: false,
    startWithTranscription: false
  } as any)

  return { eventId }
}

async function resolveSession (eventId: string): Promise<{ status: number, body: any }> {
  const res = await fetch(`${loveEndpoint()}/resolveSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getPlatformToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

export function registerRecurringTests (): void {
  test.describe('meeting minutes - recurring meetings', () => {
    test.use({ storageState: PlatformSetting })

    // Nothing in meetings-ws is cleaned up between runs; only this spec's own titles are dropped.
    test.beforeAll(async () => {
      await dropStaleMeetings({ eventTitlePrefixes: [SERIES_TITLE] })
    })

    test('scheduling a series creates no session until an occurrence comes', async () => {
      const { eventId } = await createSeries({ startsIn: 3 * DAY, weekly: true })
      const sys = await getSystemRestClient()

      const sessions = await sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, { eventId })
      expect(sessions).toHaveLength(0)
    })

    test('a series outside its window reports when to come back', async () => {
      const { eventId } = await createSeries({ startsIn: 3 * DAY, weekly: true })

      const { status, body } = await resolveSession(eventId)

      expect(status).toBe(403)
      // The date is the occurrence itself, so a client can show a countdown rather than a refusal.
      expect(typeof body.nextOccurrence).toBe('number')
      expect(body.nextOccurrence).toBeGreaterThan(Date.now())
    })

    test('the service opens one session per occurrence, pinned to its start', async () => {
      const { eventId } = await createSeries({ startsIn: 5 * 60 * 1000, weekly: true })

      const first = await resolveSession(eventId)
      expect(first.status).toBe(200)
      expect(typeof first.body.meetingId).toBe('string')

      // Asking twice must not open a second session for the same occurrence.
      const second = await resolveSession(eventId)
      expect(second.body.meetingId).toBe(first.body.meetingId)

      const sys = await getSystemRestClient()
      const session = await sys.findOne<MeetingMinutes>(love.class.MeetingMinutes, { _id: first.body.meetingId })
      expect(session?.eventId).toBe(eventId)
      expect(session?.occurrence).toBe(first.body.occurrence)
      // A scheduled meeting occupies no ordinary room, only the one service room.
      expect(session?.roomId).toBe(love.ids.ScheduledRoom)
    })

    test('a plain meeting works the same way as a series', async () => {
      const { eventId } = await createSeries({ startsIn: 5 * 60 * 1000, weekly: false })

      const { status, body } = await resolveSession(eventId)

      expect(status).toBe(200)
      expect(typeof body.meetingId).toBe('string')
    })

    test('an unknown event is not a meeting', async () => {
      const { status } = await resolveSession('no-such-event-id')
      expect(status).toBe(404)
    })

    test('the link of a series survives its occurrences', async () => {
      const { eventId } = await createSeries({ startsIn: 2 * DAY, weekly: true })

      // System token: this is about the link being stable, not about who may ask for one.
      const link = async (): Promise<any> => {
        const res = await fetch(`${loveEndpoint()}/meetingLink?eventId=${eventId}`, {
          headers: { Authorization: `Bearer ${await getSystemToken()}` }
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
      }

      const first = await link()
      expect(first.status).toBe(200)
      expect(typeof first.body.shortId).toBe('string')

      // Deduplicated by payload, so one meeting keeps one URL however often it is asked for.
      const second = await link()
      expect(second.body.shortId).toBe(first.body.shortId)
    })
  })
}
