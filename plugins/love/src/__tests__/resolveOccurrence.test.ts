import { type Event, type ReccuringEvent } from '@hcengineering/calendar'
import { SCHEDULED_JOIN_LEAD_MS, SCHEDULED_MEETING_WINDOW_MS, meetingOccurrences, resolveOccurrence } from '../utils'

const hour = 60 * 60 * 1000
const day = 24 * hour
const start = new Date('2026-03-02T10:00:00Z').getTime()

function plain (date: number = start): Event {
  const res: Record<string, unknown> = { eventId: 'E1', date, dueDate: date + hour, allDay: false }
  return res as unknown as Event
}

function series (extra: Record<string, unknown> = {}): ReccuringEvent {
  const res: Record<string, unknown> = {
    ...(plain() as unknown as Record<string, unknown>),
    rules: [{ freq: 'DAILY', interval: 1 }],
    ...extra
  }
  return res as unknown as ReccuringEvent
}

describe('resolveOccurrence lookahead', () => {
  it('still finds the next occurrence of a yearly series', () => {
    // A flat 90-day window reported no `next`, and checkMeetingLink then expired a live link.
    const yearly = series({ rules: [{ freq: 'YEARLY', interval: 1 }] })
    const { current, next } = resolveOccurrence(yearly, start + 2 * day)
    expect(current).toBeUndefined()
    expect(next).toBeGreaterThan(start + 300 * day)
  })

  it('still finds the next occurrence of a half-yearly series', () => {
    const halfYearly = series({ rules: [{ freq: 'MONTHLY', interval: 6 }] })
    expect(resolveOccurrence(halfYearly, start + 2 * day).next).toBeGreaterThan(start + 100 * day)
  })
})

describe('meetingOccurrences', () => {
  it('returns the single start of a plain event inside the window', () => {
    expect(meetingOccurrences(plain(), start - day, start + day)).toEqual([start])
    expect(meetingOccurrences(plain(), start + hour, start + day)).toEqual([])
  })

  it('expands a daily series', () => {
    expect(meetingOccurrences(series(), start, start + 3 * day)).toEqual([start, start + day, start + 2 * day])
  })

  it('honours exdate and rdate', () => {
    const withHoles = series({ exdate: [start + day], rdate: [start + 12 * hour] })
    expect(meetingOccurrences(withHoles, start, start + 3 * day)).toEqual([start, start + 12 * hour, start + 2 * day])
  })

  it('treats an rdate-only event as recurring', () => {
    const sparse = series({ rules: undefined, rdate: [start + 5 * day] })
    expect(meetingOccurrences(sparse, start, start + 7 * day)).toEqual([start + 5 * day])
  })
})

describe('resolveOccurrence', () => {
  it('opens the window before the start', () => {
    const { current, next } = resolveOccurrence(plain(), start - SCHEDULED_JOIN_LEAD_MS)
    expect(current).toEqual(start)
    expect(next).toBeUndefined()
  })

  it('keeps the window open until it expires', () => {
    expect(resolveOccurrence(plain(), start + SCHEDULED_MEETING_WINDOW_MS - 1).current).toEqual(start)
    expect(resolveOccurrence(plain(), start + SCHEDULED_MEETING_WINDOW_MS).current).toBeUndefined()
  })

  it('points at the next occurrence when none is open', () => {
    // Too early for today's: the caller is told when to come back.
    const { current, next } = resolveOccurrence(series(), start - 2 * hour)
    expect(current).toBeUndefined()
    expect(next).toEqual(start)
  })

  it('prefers the occurrence in progress over the one that follows', () => {
    const { current, next } = resolveOccurrence(series(), start + hour)
    expect(current).toEqual(start)
    expect(next).toEqual(start + day)
  })

  it('reports neither once a finished plain event falls out of the window', () => {
    expect(resolveOccurrence(plain(), start + day)).toEqual({ current: undefined, next: undefined })
  })

  it('skips an excluded occurrence and offers the following one', () => {
    const withHole = series({ exdate: [start] })
    const { current, next } = resolveOccurrence(withHole, start)
    expect(current).toBeUndefined()
    expect(next).toEqual(start + day)
  })
})
