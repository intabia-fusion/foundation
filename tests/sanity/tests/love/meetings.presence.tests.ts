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
import core, { type Class, type Doc, type Ref } from '@hcengineering/core'
import love, { type ParticipantInfo, type Room } from '@hcengineering/love'
import {
  closeMeetingContexts,
  firstAvailableRoom,
  getMeetingsUser,
  joinRoom,
  loveWindow,
  occupiedCells,
  openLove,
  waitForActiveMeetingsToFinish
} from './meeting-helpers'

// `@hcengineering/contact` is not a dependency of the sanity package; the class
// id is stable, and only `_id`/`name` are read from the result.
interface PersonLike extends Doc {
  name: string
}
const PERSON_CLASS = 'contact:class:Person' as Ref<Class<PersonLike>>

export function registerPresenceTests (): void {
  test.describe('meeting minutes - presence on the floor grid', () => {
    test('two participants occupy two distinct cells', async ({ browser }) => {
      test.setTimeout(120000)
      const { ctx: ctxA, page: pageA } = await loveWindow(browser, 'second')
      const { ctx: ctxB, page: pageB } = await loveWindow(browser, 'third')
      try {
        const room = await firstAvailableRoom(pageA)
        test.skip(room === null, 'No regular room available')
        await joinRoom(pageA, room as string)

        await openLove(pageB)
        await joinRoom(pageB, room as string)

        // Both sides must render two separate avatars: a collapsed pair is the
        // "everyone sits in one cell" defect.
        await expect.poll(async () => await occupiedCells(pageA, room as string), { timeout: 30000 }).toBe(2)
        await expect.poll(async () => await occupiedCells(pageB, room as string), { timeout: 30000 }).toBe(2)
      } finally {
        await closeMeetingContexts([
          { ctx: ctxA, pages: [pageA] },
          { ctx: ctxB, pages: [pageB] }
        ])
      }
    })

    test('colliding coordinates are spread across cells instead of stacking', async ({ browser }) => {
      test.setTimeout(90000)
      const { client } = await getMeetingsUser()
      const created: Array<Ref<ParticipantInfo>> = []
      const { ctx, page } = await loveWindow(browser, 'second')
      try {
        const roomName = await firstAvailableRoom(page)
        test.skip(roomName === null, 'No regular room available')

        const rooms = await client.findAll<Room>(love.class.Room, { name: roomName as string })
        test.skip(rooms.length === 0, 'Room document not found')
        const persons = await client.findAll<PersonLike>(PERSON_CLASS, {}, { limit: 3 })
        test.skip(persons.length < 3, 'Need three persons in the workspace')

        // Every row claims (0,0). The floor view is expected to resolve the
        // collision, not to paint three avatars on top of each other.
        for (const person of persons) {
          const id = await client.createDoc<ParticipantInfo>(love.class.ParticipantInfo, core.space.Workspace, {
            person: person._id,
            name: person.name,
            room: rooms[0]._id,
            x: 0,
            y: 0,
            sessionId: null,
            account: null
          } as any)
          created.push(id)
        }

        await expect.poll(async () => await occupiedCells(page, roomName as string), { timeout: 30000 }).toBe(3)
      } finally {
        for (const id of created) {
          await client.removeDoc(love.class.ParticipantInfo, core.space.Workspace, id).catch(() => undefined)
        }
        await page.close().catch(() => undefined)
        await ctx.close().catch(() => undefined)
        await waitForActiveMeetingsToFinish()
      }
    })
  })
}
