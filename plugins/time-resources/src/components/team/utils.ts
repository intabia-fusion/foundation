// Copyright © 2023 Hardcore Engineering Inc.
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

import { type BusySlot, type Calendar, type Event, getBusyIntervals } from '@hcengineering/calendar'
import { isVisible } from '@hcengineering/calendar-resources'
import { type Contact, type Employee, type Person } from '@hcengineering/contact'
import { type IdMap, type Ref, type Timestamp } from '@hcengineering/core'
import { type ToDo, type WorkSlot } from '@hcengineering/time'
import { getClient } from '@hcengineering/presentation'
import workbench, { type Widget } from '@hcengineering/workbench'
import { openWidget } from '@hcengineering/workbench-resources'
import time from '../../plugin'
import { type EventPersonMapping } from '../../types'

export function isVisibleMe (value: Event, me: Ref<Contact>): boolean {
  if (value.participants.includes(me)) {
    return true
  }
  return false
}
function isVisibleAll (value: ToDo, mePerson: Ref<Person>): boolean {
  // My own todos are always shown in full - visibility only hides them from colleagues.
  if (value.user === (mePerson as unknown as Ref<Employee>)) {
    return true
  }
  return value.visibility === 'public' || value.visibility === undefined
}

function emptyMapping (user: Ref<Person>): EventPersonMapping {
  return {
    busy: { slots: [], total: 0, user },
    mappings: [],
    user,
    total: 0,
    events: [],
    busyTotal: 0,
    busyEvents: [],
    busySlots: [],
    namedBusy: []
  }
}

export function groupTeamData (
  items: WorkSlot[],
  todos: IdMap<ToDo>,
  events: Event[],
  busySlots: BusySlot[],
  mePerson: Ref<Person>,
  calendarStore: IdMap<Calendar>,
  from: Timestamp,
  to: Timestamp
): EventPersonMapping[] {
  const result = new Map<Ref<Person>, EventPersonMapping>()

  const totalEventsMap = new Map<Ref<Person>, EventVars[]>()
  for (const slot of items) {
    const todo = todos.get(slot.attachedTo)
    if (todo === undefined) {
      continue
    }
    const mapping: EventPersonMapping = result.get(todo.user) ?? emptyMapping(todo.user)
    result.set(todo.user, mapping)

    const totalEvents = totalEventsMap.get(todo.user) ?? []
    const over = calcOverlap(totalEvents, slot)
    totalEvents.push(...over.events)
    totalEventsMap.set(todo.user, totalEvents)
    if (isVisibleAll(todo, mePerson)) {
      let mm = mapping.mappings.find((it) => it.todo?._id === todo._id)
      if (mm === undefined) {
        mm = {
          todo,
          slots: [],
          user: todo.user,
          total: 0
        }
        mapping.mappings.push(mm)
      }
      mm.total += over.total
      mm.slots.push({ ...slot, overlap: slot.dueDate - slot.date - over.total })
    } else {
      mapping.busy.slots.push(slot)
      mapping.busy.total += over.total
    }
    mapping.total += over.total
  }

  for (const event of events) {
    const _calendar = calendarStore.get(event.calendar)
    if (_calendar === undefined || _calendar.hidden) {
      continue
    }
    for (const p of event.participants as Array<Ref<Person>>) {
      const mapping: EventPersonMapping = result.get(p) ?? emptyMapping(p)
      result.set(p, mapping)
      if (mapping.events.find((it) => it.eventId === event.eventId) === undefined) {
        const totalEvents = totalEventsMap.get(p) ?? []
        const over = calcOverlap(totalEvents, event)
        totalEvents.push(...over.events)
        totalEventsMap.set(p, totalEvents)

        if (isVisible(event, calendarStore) || isVisibleMe(event, mePerson)) {
          mapping.total += over.total
          mapping.events.push({ ...event, overlap: event.dueDate - event.date - over.total })
        } else {
          mapping.busyTotal += over.total
          mapping.busyEvents.push(event)
        }
      }
    }
  }

  // A public event keeps its title on the slot, so it is listed by name instead of being
  // folded into the anonymous busy total.
  for (const slot of busySlots.filter((it) => (it.title ?? '') !== '')) {
    for (const [p, intervals] of getBusyIntervals([slot], from, to)) {
      const mapping = result.get(p) ?? emptyMapping(p)
      result.set(p, mapping)
      const totalEvents = totalEventsMap.get(p) ?? []
      for (const interval of intervals) {
        const over = calcOverlap(totalEvents, interval)
        totalEvents.push(...over.events)
        mapping.namedBusy.push({ ...interval, title: slot.title ?? '' })
      }
      totalEventsMap.set(p, totalEvents)
    }
  }

  // Other people's busy time - no event content, just intervals.
  for (const [p, intervals] of getBusyIntervals(
    busySlots.filter((it) => (it.title ?? '') === ''),
    from,
    to
  )) {
    const mapping: EventPersonMapping = result.get(p) ?? emptyMapping(p)
    result.set(p, mapping)

    const totalEvents = totalEventsMap.get(p) ?? []
    for (const interval of intervals) {
      const over = calcOverlap(totalEvents, interval)
      totalEvents.push(...over.events)
      mapping.busyTotal += over.total
      mapping.busySlots.push({ ...interval, overlap: interval.dueDate - interval.date - over.total })
    }
    totalEventsMap.set(p, totalEvents)
  }
  return Array.from(result.values())
}

/**
 * @public
 */
export const toSlots = (events: Event[]): WorkSlot[] => events as WorkSlot[]

type EventVars = Pick<Event, 'date' | 'dueDate'>

/**
 * Inside:
 * A: ------------------
 * B: ....----------....
 *
 * Before:
 * A: ...------------------
 * B: vvv--------..........
 *
 * After:
 * A: -------------------...
 * B: ....---------------vvv
 *
 * Outside:
 * A: ...-------------------...
 * B: vvv-------------------vvv
 */
function crossWith (a: EventVars, b: EventVars): EventVars[] {
  const newTmp: EventVars[] = []
  // Before
  if (b.date <= a.date) {
    const n = { date: b.date, dueDate: Math.min(a.date, b.dueDate) }
    if (n.dueDate - n.date > 0) {
      newTmp.push(n)
    }
  }
  // After
  if (a.dueDate <= b.dueDate) {
    const n = { date: Math.max(a.dueDate, b.date), dueDate: b.dueDate }
    if (n.dueDate - n.date > 0) {
      newTmp.push(n)
    }
  }
  return newTmp
}

/**
 *
 * @param events - without overlaps
 * @param event - any object with date and dueDate properties
 * @returns
 */
function calcOverlap (events: EventVars[], event: EventVars): { events: EventVars[], total: number } {
  let tmp: EventVars[] = [{ date: event.date, dueDate: event.dueDate }]
  for (const a of events) {
    const newTmp: EventVars[] = []
    for (const b of tmp) {
      newTmp.push(...crossWith(a, b))
    }
    tmp = newTmp
  }
  return { events: tmp, total: tmp.reduce((v, it) => v + (it.dueDate - it.date), 0) }
}

/**
 * Opens the person's own day in the sidebar - as much of it as the viewer is allowed to see.
 */
export function openPersonDay (person: Ref<Person>, date: Timestamp): void {
  const widget = getClient()
    .getModel()
    .findAllSync(workbench.class.Widget, { _id: time.ids.PersonDayWidget as Ref<Widget> })[0]
  if (widget === undefined) return
  openWidget(widget, { person, date }, { active: true, openedByUser: true })
}
