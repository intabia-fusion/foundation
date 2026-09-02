<!--
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
-->
<script lang="ts">
  import calendar, { BusySlot, Calendar, Event } from '@hcengineering/calendar'
  import { visibleCalendarStore, hidePrivateEvents, calendarByIdStore } from '@hcengineering/calendar-resources'
  import { getCurrentEmployee, Person } from '@hcengineering/contact'
  import { IdMap, Ref, toIdMap } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import task, { Project } from '@hcengineering/task'
  import time, { ToDo, WorkSlot } from '@hcengineering/time'

  export let spaces: Array<Ref<Project>> = []
  export let fromDate: number
  export let toDate: number
  export let projects: Project[] = []
  export let slots: WorkSlot[] = []
  export let events: Event[] = []
  export let todos: IdMap<ToDo> = new Map()
  export let persons: Ref<Person>[] = []
  export let busySlots: BusySlot[] = []

  const me = getCurrentEmployee()

  const client = getClient()

  const spaceQuery = createQuery()
  $: if (spaces.length > 0) {
    spaceQuery.query(task.class.Project, { _id: { $in: spaces } }, (res) => {
      projects = res
    })
  } else {
    spaceQuery.unsubscribe()
    projects = []
  }

  const query = createQuery()
  const queryR = createQuery()
  let raw: Event[] = []
  let rawEvent: Event[] = []
  let rawReq: Event[] = []

  let calendarIds: Ref<Calendar>[] = []

  // Own events only - details of colleagues' events come from BusySlot instead.
  $: query.query(
    calendar.class.Event,
    {
      _class: { $ne: calendar.class.ReccuringEvent },
      calendar: { $in: calendarIds },
      date: { $lte: toDate },
      dueDate: { $gte: fromDate },
      participants: { $in: [me] } as any
    },
    (res) => {
      rawEvent = res
    }
  )

  $: queryR.query(
    calendar.class.ReccuringEvent,
    { calendar: { $in: calendarIds }, participants: { $in: [me] } as any },
    (res) => {
      rawReq = res
    }
  )

  $: otherPersons = persons.filter((p) => p !== me)

  const busyQuery = createQuery()
  const busyQueryR = createQuery()
  let rawBusy: BusySlot[] = []
  let rawBusyR: BusySlot[] = []

  $: busyQuery.query(
    calendar.class.BusySlot,
    {
      rules: { $exists: false },
      person: { $in: otherPersons },
      date: { $lte: toDate },
      dueDate: { $gte: fromDate }
    },
    (res) => {
      rawBusy = res
    }
  )

  $: busyQueryR.query(calendar.class.BusySlot, { rules: { $exists: true }, person: { $in: otherPersons } }, (res) => {
    rawBusyR = res
  })

  // WorkSlots of the selected projects - covers colleagues too, membership in the project space guards access.
  // Never recurring (nothing sets WorkSlot.rules), so a single query is enough.
  const projectSlotQuery = createQuery()
  let rawProjectSlots: WorkSlot[] = []
  $: if (spaces.length > 0) {
    projectSlotQuery.query(
      time.class.WorkSlot,
      { space: { $in: spaces }, date: { $lte: toDate }, dueDate: { $gte: fromDate } },
      (res) => {
        rawProjectSlots = res
      }
    )
  } else {
    projectSlotQuery.unsubscribe()
    rawProjectSlots = []
  }

  $: raw = rawEvent.concat(rawReq).filter((it, idx, arr) => arr.findIndex((e) => e.eventId === it.eventId) === idx)

  // Every event and WorkSlot has a paired BusySlot per participant. Whenever the detailed
  // document is already on hand - a project slot, or an event I take part in, which carries
  // its whole participant list - its BusySlot must go, or calcOverlap counts the time twice.
  $: knownEventIds = new Set([...rawProjectSlots, ...raw].map((it) => it.eventId))
  $: busySlots = rawBusy.concat(rawBusyR).filter((it) => !knownEventIds.has(it.eventId))

  // Only my own events are fetched here, so private ones must stay - I am allowed to see them.
  $: visible = hidePrivateEvents(raw, $calendarByIdStore, true)

  const todoQuery = createQuery()

  $: ownSlots = visible.filter((it) => client.getHierarchy().isDerived(it._class, time.class.WorkSlot)) as WorkSlot[]
  $: events = visible.filter((it) => !client.getHierarchy().isDerived(it._class, time.class.WorkSlot))
  // Own slots may already include this project (fetched above by calendar/participants) - don't duplicate them.
  $: slots = ownSlots.concat(rawProjectSlots.filter((it) => !ownSlots.some((s) => s._id === it._id)))

  $: todoQuery.query(
    time.class.ToDo,
    {
      _id: { $in: slots.map((it) => it.attachedTo).filter((it, idx, arr) => arr.indexOf(it) === idx) }
    },
    (res) => {
      todos = toIdMap(res)
    }
  )

  $: calendarIds = $visibleCalendarStore.map((p) => p._id)
</script>
