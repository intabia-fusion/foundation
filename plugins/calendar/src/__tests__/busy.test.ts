import { Ref } from '@hcengineering/core'
import { Person } from '@hcengineering/contact'
import { BusySlot } from '..'
import { getBusyIntervals } from '../utils'

const person = 'person1' as Ref<Person>
const hour = 60 * 60 * 1000

function slot (date: number, dueDate: number, extra: Partial<BusySlot> = {}): BusySlot {
  const res: Partial<BusySlot> = { person, eventId: 'e1', date, dueDate, allDay: false, ...extra }
  return res as BusySlot
}

describe('getBusyIntervals', () => {
  const day = new Date('2024-01-01T00:00:00Z').getTime()
  const week = day + 7 * 24 * hour

  it('keeps a plain slot inside the window', () => {
    const res = getBusyIntervals([slot(day + hour, day + 2 * hour)], day, day + 24 * hour)
    expect(res.get(person)).toEqual([{ date: day + hour, dueDate: day + 2 * hour }])
  })

  it('drops a slot outside the window', () => {
    // A person with nothing inside the window is free, so they must not show up at all.
    const res = getBusyIntervals([slot(day - 5 * hour, day - 4 * hour)], day, day + 24 * hour)
    expect(res.has(person)).toBe(false)
  })

  it('merges overlapping slots', () => {
    const res = getBusyIntervals(
      [slot(day + hour, day + 3 * hour), slot(day + 2 * hour, day + 4 * hour)],
      day,
      day + 24 * hour
    )
    expect(res.get(person)).toEqual([{ date: day + hour, dueDate: day + 4 * hour }])
  })

  it('expands a daily rule and honours exdate', () => {
    const busy = slot(day + hour, day + 2 * hour, {
      rules: [{ freq: 'DAILY', interval: 1 }],
      exdate: [day + 24 * hour + hour]
    })
    const res = getBusyIntervals([busy], day, week)
    const dates = res.get(person)?.map((it) => it.date) ?? []
    expect(dates).not.toContain(day + 24 * hour + hour)
    expect(dates).toContain(day + hour)
    expect(dates).toContain(day + 2 * 24 * hour + hour)
  })

  it('catches an occurrence that started before the window', () => {
    const busy = slot(day - hour, day + hour, { rules: [{ freq: 'DAILY', interval: 1 }] })
    const res = getBusyIntervals([busy], day, day + 30 * 60 * 1000)
    expect(res.get(person)).toEqual([{ date: day, dueDate: day + 30 * 60 * 1000 }])
  })
})
