import { Ref } from '@hcengineering/core'
import { Person } from '@hcengineering/contact'
import calendar, { Event, ReccuringEvent, ReccuringInstance } from '..'
import { busySlotData } from '../utils'

const person = 'person1' as Ref<Person>
const hour = 60 * 60 * 1000
const day = new Date('2024-01-01T09:00:00Z').getTime()

function plain (extra: Record<string, unknown> = {}): Event {
  const res: Record<string, unknown> = {
    _class: calendar.class.Event,
    eventId: 'e1',
    date: day,
    dueDate: day + hour,
    allDay: false,
    title: 'Standup',
    visibility: 'private',
    ...extra
  }
  return res as unknown as Event
}

function master (extra: Record<string, unknown> = {}): ReccuringEvent {
  return plain({
    _class: calendar.class.ReccuringEvent,
    rules: [{ freq: 'DAILY', interval: 1 }],
    rdate: [],
    exdate: [],
    ...extra
  }) as ReccuringEvent
}

describe('busySlotData', () => {
  it('leaves recurrence unset on a plain event', () => {
    const res = busySlotData(plain(), person)
    // `undefined`, not `[]`: the client tells recurring from plain by `rules: { $exists: true }`.
    expect(res.rules).toBeUndefined()
    expect(res.exdate).toBeUndefined()
    expect(res.rdate).toBeUndefined()
  })

  it('hides the title of a non-public event', () => {
    expect(busySlotData(plain(), person).title).toEqual('')
    expect(busySlotData(plain({ visibility: 'freeBusy' }), person).title).toEqual('')
    expect(busySlotData(plain({ visibility: 'public' }), person).title).toEqual('Standup')
  })

  it('merges overridden occurrences into the master exdate', () => {
    const res = busySlotData(master({ exdate: [day + 24 * hour] }), person, [day + 48 * hour])
    expect(res.rules).toHaveLength(1)
    expect(res.exdate).toEqual([day + 24 * hour, day + 48 * hour])
  })

  it('does not repeat a date already excluded by the series', () => {
    const res = busySlotData(master({ exdate: [day + 24 * hour] }), person, [day + 24 * hour])
    expect(res.exdate).toEqual([day + 24 * hour])
  })

  it('strips the series from an overridden occurrence', () => {
    // An override inherits `rules` from the master it was cut out of - keeping them would
    // block the whole series at the overridden time.
    const instance = master({
      _class: calendar.class.ReccuringInstance,
      recurringEventId: 'e1',
      eventId: 'e2',
      originalStartTime: day
    }) as ReccuringInstance
    const res = busySlotData(instance, person, [day])
    expect(res.rules).toBeUndefined()
    expect(res.exdate).toBeUndefined()
    expect(res.rdate).toBeUndefined()
    expect(res.eventId).toEqual('e2')
  })

  it('keeps rdate-only recurrence without inventing an exdate', () => {
    const res = busySlotData(plain({ _class: calendar.class.ReccuringEvent, rdate: [day + 72 * hour] }), person)
    expect(res.rdate).toEqual([day + 72 * hour])
    expect(res.exdate).toBeUndefined()
  })
})
