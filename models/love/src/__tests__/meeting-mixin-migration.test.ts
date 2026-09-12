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
import { AccessLevel, DOMAIN_EVENT } from '@hcengineering/model-calendar'
import { DOMAIN_SPACE } from '@hcengineering/model-core'
import { MeetingStatus, RoomType, defaultMeetingAccess } from '@hcengineering/love'
import type { Domain } from '@hcengineering/core'
import type { MigrationClient } from '@hcengineering/model'
import { DOMAIN_LOVE } from '..'
import love from '../plugin'
import { meetingSettingsToMixin, stripMixinFromNonMasters } from '../migration'

// The status this migration converts away from: gone from the enum, still present in old data.
const OLD_STATUS_SCHEDULED = 7 as MeetingStatus

const MIXIN = love.mixin.MeetingEventLink as unknown as string

type Row = Record<string, any>

function matches (doc: Row, query: Row): boolean {
  for (const key of Object.keys(query)) {
    const cond: unknown = query[key]
    const value: unknown = doc[key]
    if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
      const op = cond as { $exists?: boolean, $in?: unknown[], $ne?: unknown }
      if (op.$exists !== undefined && (value !== undefined) !== op.$exists) return false
      if (op.$in !== undefined && !op.$in.includes(value)) return false
      if (op.$ne !== undefined && value === op.$ne) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

// Enough of MigrationClient for these two functions: in-memory domains, the query subset they
// actually use, and an update that understands `$unset`.
function fakeClient (data: Record<string, Row[]>): MigrationClient & { rows: (d: Domain) => Row[] } {
  const rows = (d: Domain): Row[] => data[d] ?? (data[d] = [])
  const client: any = {
    logger: { log: () => {}, error: () => {} },
    rows,
    find: async (domain: Domain, query: Row) => rows(domain).filter((it) => matches(it, query)),
    traverse: async (domain: Domain, query: Row) => {
      let sent = false
      return {
        next: async () => {
          if (sent) return null
          sent = true
          return rows(domain).filter((it) => matches(it, query))
        },
        close: async () => {}
      }
    },
    update: async (domain: Domain, query: Row, ops: Row) => {
      for (const doc of rows(domain).filter((it) => matches(it, query))) {
        for (const [key, value] of Object.entries(ops)) {
          if (key === '$unset') {
            for (const unset of Object.keys(value)) doc[unset] = undefined
          } else {
            doc[key] = value
          }
        }
      }
    },
    deleteMany: async (domain: Domain, query: Row) => {
      data[domain] = rows(domain).filter((it) => !matches(it, query))
    }
  }
  return client
}

function event (id: string, eventId: string, extra: Row = {}): Row {
  return { _id: id, _class: 'calendar:class:Event', eventId, access: AccessLevel.Owner, date: 1000, ...extra }
}

describe('meetingSettingsToMixin', () => {
  const room = { _id: 'room1', _class: love.class.Room, type: RoomType.Audio }

  function scheduledSetup (sessionExtra: Row = {}, eventExtra: Row = {}): Record<string, Row[]> {
    return {
      [DOMAIN_LOVE]: [room],
      [DOMAIN_EVENT]: [event('ev1', 'E1', { [MIXIN]: { room: 'room1', meetingId: 'm1' }, ...eventExtra })],
      [DOMAIN_SPACE]: [
        {
          _id: 'm1',
          _class: love.class.MeetingMinutes,
          status: OLD_STATUS_SCHEDULED,
          roomId: 'room1',
          private: true,
          language: 'en',
          startWithRecording: true,
          ...sessionExtra
        }
      ]
    }
  }

  it('moves the settings of a scheduled session onto the master mixin', async () => {
    const data = scheduledSetup()
    const client = fakeClient(data)
    await meetingSettingsToMixin(client)

    expect(data[DOMAIN_EVENT][0][MIXIN]).toMatchObject({
      type: RoomType.Audio,
      linkVersion: 1,
      meetingAccess: defaultMeetingAccess,
      private: true,
      language: 'en',
      startWithRecording: true,
      startWithTranscription: false,
      // The old fields survive this step - the resolver still reads them (F1 §7).
      room: 'room1',
      meetingId: 'm1'
    })
  })

  it('drops the scheduled session - it never took place', async () => {
    const data = scheduledSetup()
    await meetingSettingsToMixin(fakeClient(data))
    expect(data[DOMAIN_SPACE]).toHaveLength(0)
  })

  it('treats a non-audio room as video', async () => {
    const data = scheduledSetup()
    data[DOMAIN_LOVE][0].type = RoomType.Reception
    await meetingSettingsToMixin(fakeClient(data))
    expect(data[DOMAIN_EVENT][0][MIXIN].type).toEqual(RoomType.Video)
  })

  it('pins a live session to its series instead of deleting it', async () => {
    // `occurrence` is what the earlier meeting-minutes-to-space-v2 leaves behind.
    const data = scheduledSetup({ status: MeetingStatus.Active, occurrence: 555 })
    await meetingSettingsToMixin(fakeClient(data))

    expect(data[DOMAIN_SPACE]).toHaveLength(1)
    expect(data[DOMAIN_SPACE][0]).toMatchObject({ eventId: 'E1', occurrence: 555 })
    // A live session must not rewrite the series settings.
    expect(data[DOMAIN_EVENT][0][MIXIN].linkVersion).toBeUndefined()
  })

  it('falls back to the event start when the session has no scheduled date', async () => {
    const data = scheduledSetup({ status: MeetingStatus.Pending })
    await meetingSettingsToMixin(fakeClient(data))
    expect(data[DOMAIN_SPACE][0].occurrence).toEqual(1000)
  })

  it('leaves finished sessions alone', async () => {
    const data = scheduledSetup({ status: MeetingStatus.Finished })
    await meetingSettingsToMixin(fakeClient(data))
    expect(data[DOMAIN_SPACE]).toHaveLength(1)
    expect(data[DOMAIN_SPACE][0].eventId).toBeUndefined()
  })

  it('ignores a materialized occurrence - it is not the master', async () => {
    // An override answers the master query too, and the next state strips its mixin.
    const data = scheduledSetup()
    // Appended: the map keeps the last row it sees for a meetingId.
    data[DOMAIN_EVENT].push(
      event('inst1', 'E1', {
        _class: 'calendar:class:ReccuringInstance',
        [MIXIN]: { room: 'room1', meetingId: 'm1' }
      })
    )
    await meetingSettingsToMixin(fakeClient(data))

    const instance = data[DOMAIN_EVENT].find((it) => it._id === 'inst1')
    const master = data[DOMAIN_EVENT].find((it) => it._id === 'ev1')
    expect((instance as any)[MIXIN].linkVersion).toBeUndefined()
    expect((master as any)[MIXIN].linkVersion).toEqual(1)
  })

  it('ignores a copy carrying the mixin - only the master is written', async () => {
    const data = scheduledSetup()
    data[DOMAIN_EVENT].push(
      event('ev2', 'E1', { [MIXIN]: { room: 'room1', meetingId: 'm1' }, access: AccessLevel.Reader })
    )
    await meetingSettingsToMixin(fakeClient(data))

    expect(data[DOMAIN_EVENT][0][MIXIN].linkVersion).toEqual(1)
    expect(data[DOMAIN_EVENT][1][MIXIN].linkVersion).toBeUndefined()
  })
})

describe('stripMixinFromNonMasters', () => {
  it('keeps the mixin on the master and removes it everywhere else', async () => {
    const data: Record<string, Row[]> = {
      [DOMAIN_EVENT]: [
        event('master', 'E1', { [MIXIN]: { meetingId: 'm1' } }),
        event('copy', 'E1', { [MIXIN]: { meetingId: 'm1' }, access: AccessLevel.Reader }),
        event('override', 'E2', {
          [MIXIN]: { meetingId: 'm1' },
          _class: 'calendar:class:ReccuringInstance',
          recurringEventId: 'E1'
        })
      ]
    }
    await stripMixinFromNonMasters(fakeClient(data))

    expect(data[DOMAIN_EVENT][0][MIXIN]).toBeDefined()
    expect(data[DOMAIN_EVENT][1][MIXIN]).toBeUndefined()
    // An owner-access override would otherwise keep a permanent link of its own.
    expect(data[DOMAIN_EVENT][2][MIXIN]).toBeUndefined()
  })
})
