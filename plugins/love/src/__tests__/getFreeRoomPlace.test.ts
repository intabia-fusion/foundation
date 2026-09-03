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

import { type Ref } from '@hcengineering/core'
import { type Person } from '@hcengineering/contact'
import { getFreeRoomPlace } from '../utils'
import { type Office, type ParticipantInfo, type Room, RoomType } from '../types'

const owner = 'owner' as Ref<Person>
const guest = 'guest' as Ref<Person>

function room (width: number, height: number, person?: Ref<Person>): Room {
  const base = {
    _id: 'room' as Ref<Room>,
    name: 'r',
    type: RoomType.Video,
    width,
    height
  } as unknown as Room
  return person !== undefined ? ({ ...base, person } as unknown as Office) : base
}

function at (x: number, y: number): ParticipantInfo {
  return { x, y } as unknown as ParticipantInfo
}

describe('getFreeRoomPlace', () => {
  it('ignores a preference outside the room grid', () => {
    expect(getFreeRoomPlace(room(4, 3), [], guest, { x: -1, y: -1 })).toEqual({ x: 0, y: 0 })
    expect(getFreeRoomPlace(room(4, 3), [], guest, { x: 9, y: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('honours a free in-grid preference', () => {
    expect(getFreeRoomPlace(room(4, 3), [], guest, { x: 2, y: 1 })).toEqual({ x: 2, y: 1 })
  })

  it('falls back to a scan when the preferred cell is taken', () => {
    expect(getFreeRoomPlace(room(4, 3), [at(2, 1)], guest, { x: 2, y: 1 })).toEqual({ x: 0, y: 0 })
  })

  it('keeps (0,0) of an office for its owner', () => {
    const office = room(2, 1, owner)
    expect(getFreeRoomPlace(office, [], owner)).toEqual({ x: 0, y: 0 })
    expect(getFreeRoomPlace(office, [], guest)).toEqual({ x: 1, y: 0 })
  })

  it('does not hand the office owner seat to a guest via pref', () => {
    const office = room(2, 1, owner)
    expect(getFreeRoomPlace(office, [], guest, { x: 0, y: 0 })).toEqual({ x: 1, y: 0 })
  })

  it('overflows along x, never past the last row', () => {
    // A 2x1 office holds owner + 1; the third must still land on a renderable cell.
    const office = room(2, 1, owner)
    const place = getFreeRoomPlace(office, [at(0, 0), at(1, 0)], guest)
    expect(place.y).toBe(0)
    expect(place.x).toBe(2)

    const next = getFreeRoomPlace(office, [at(0, 0), at(1, 0), at(2, 0)], guest)
    expect(next).toEqual({ x: 3, y: 0 })
  })
})
