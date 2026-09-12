import { type Ref } from '@hcengineering/core'
import love from '../plugin'
import { type Floor, type Room } from '../types'
import { isServiceFloor, isServiceRoom } from '../utils'

describe('service floor', () => {
  it('recognises the scheduled floor and room by their fixed ids', () => {
    expect(isServiceFloor(love.ids.ScheduledFloor)).toBe(true)
    expect(isServiceRoom({ _id: love.ids.ScheduledRoom } as unknown as Room)).toBe(true)
  })

  it('leaves ordinary floors and rooms alone', () => {
    expect(isServiceFloor(love.ids.MainFloor)).toBe(false)
    expect(isServiceFloor('floor-1' as Ref<Floor>)).toBe(false)
    expect(isServiceRoom({ _id: love.ids.Reception } as unknown as Room)).toBe(false)
  })

  it('treats a missing floor or room as ordinary', () => {
    // Both ids resolve to '' in the plugin declaration until the model is loaded, so an
    // undefined argument must not accidentally match them.
    expect(isServiceFloor(undefined)).toBe(false)
    expect(isServiceRoom(undefined)).toBe(false)
  })
})
