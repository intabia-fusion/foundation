//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

import { type BusySlot } from '@hcengineering/calendar'
import { type Person } from '@hcengineering/contact'
import { type Ref, type Timestamp } from '@hcengineering/core'
import { groupTeamData } from '../utils'

// The module pulls in svelte packages at import time, none of which the grouping logic uses.
jest.mock('@hcengineering/presentation', () => ({ getClient: () => ({}) }))
jest.mock('@hcengineering/workbench-resources', () => ({ openWidget: () => {} }))
jest.mock('@hcengineering/calendar-resources', () => ({ isVisible: () => true }))

const me = 'me' as Ref<Person>
const other = 'other' as Ref<Person>
const day = new Date(2026, 8, 5).setHours(0, 0, 0, 0)
const hour = 60 * 60 * 1000

function slot (date: Timestamp, dueDate: Timestamp, title?: string, person: Ref<Person> = other): BusySlot {
  return {
    _id: `${person}-${date}-${title ?? ''}` as Ref<BusySlot>,
    _class: 'calendar:class:BusySlot' as any,
    space: 'calendar:space:Calendar' as any,
    modifiedBy: '' as any,
    modifiedOn: 0,
    person,
    eventId: `${person}-${date}`,
    date,
    dueDate,
    allDay: false,
    title
  }
}

function group (slots: BusySlot[], from: Timestamp = day, to: Timestamp = day + 24 * hour): any[] {
  return groupTeamData([], new Map(), [], slots, me, new Map(), from, to)
}

describe('groupTeamData busy slots', () => {
  it('keeps a public slot under its own title, apart from the anonymous total', () => {
    const res = group([slot(day + 9 * hour, day + 10 * hour, 'Demo')])
    expect(res.length).toBe(1)
    expect(res[0].namedBusy).toEqual([
      expect.objectContaining({ date: day + 9 * hour, dueDate: day + 10 * hour, title: 'Demo' })
    ])
    expect(res[0].busySlots).toEqual([])
    // Named time is listed by itself, counting it in busyTotal again would double it.
    expect(res[0].busyTotal).toBe(0)
  })

  it('anonymizes a slot without a title', () => {
    const res = group([slot(day + 9 * hour, day + 11 * hour)])
    expect(res[0].namedBusy).toEqual([])
    expect(res[0].busySlots.length).toBe(1)
    expect(res[0].busyTotal).toBe(2 * hour)
  })

  it('merges only the anonymous slots, a public one stays separate', () => {
    const res = group([
      slot(day + 9 * hour, day + 11 * hour),
      slot(day + 10 * hour, day + 12 * hour),
      slot(day + 9 * hour, day + 10 * hour, 'Demo')
    ])
    expect(res.length).toBe(1)
    expect(res[0].busySlots.length).toBe(1)
    expect(res[0].busySlots[0]).toEqual(expect.objectContaining({ date: day + 9 * hour, dueDate: day + 12 * hour }))
    expect(res[0].namedBusy.length).toBe(1)
  })

  it('drops a person whose slots all fall outside the window', () => {
    const res = group([slot(day - 5 * hour, day - 4 * hour)])
    expect(res).toEqual([])
  })
})
