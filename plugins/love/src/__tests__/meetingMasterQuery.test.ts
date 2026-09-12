import { AccessLevel, type Event, type ReccuringInstance } from '@hcengineering/calendar'
import { meetingMasterQuery } from '../utils'

describe('meetingMasterQuery', () => {
  it('resolves a plain event by its own eventId', () => {
    expect(meetingMasterQuery({ eventId: 'E1' } as unknown as Event)).toEqual({
      eventId: 'E1',
      access: AccessLevel.Owner
    })
  })

  it('resolves an override through the series it was cut out of', () => {
    // The override owns a fresh eventId and access: 'owner' of its own, so resolving by it would
    // put the meeting - linkId included - on a single occurrence.
    const instance = { eventId: 'E2', recurringEventId: 'E1' } as unknown as ReccuringInstance
    expect(meetingMasterQuery(instance)).toEqual({ eventId: 'E1', access: AccessLevel.Owner })
  })

  it('never resolves to a copy', () => {
    expect(meetingMasterQuery({ eventId: 'E1' } as unknown as Event).access).toEqual(AccessLevel.Owner)
  })
})

describe('virtual occurrence', () => {
  it('resolves an expanded occurrence through its series', () => {
    // getInstance hands every expanded occurrence a freshly generated eventId that exists in no
    // database. Addressing a meeting by it gives a 404 from the service - found on a live stand.
    const virtual = {
      eventId: 'generated-on-the-fly',
      recurringEventId: 'E1',
      virtual: true
    } as unknown as ReccuringInstance

    expect(meetingMasterQuery(virtual)).toEqual({ eventId: 'E1', access: AccessLevel.Owner })
  })
})
