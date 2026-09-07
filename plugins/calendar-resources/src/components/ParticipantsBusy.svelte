<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
<!-- Data-only: resolves which participants are already booked for the event's own time slot. -->
<script lang="ts">
  import calendar, { BusySlot, getBusyIntervals } from '@hcengineering/calendar'
  import { Person } from '@hcengineering/contact'
  import { Ref, Timestamp } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'

  export let participants: Ref<Person>[] = []
  export let date: Timestamp
  export let dueDate: Timestamp
  export let busyPersons = new Set<Ref<Person>>()
  // The event being edited books its own participants - it must not count as a clash.
  export let ignoreEventId: string | undefined = undefined

  let plainSlots: BusySlot[] = []
  let recurringSlots: BusySlot[] = []

  const plainQuery = createQuery()
  const recurringQuery = createQuery()

  // Copy the array: EventParticipants mutates it in place, and LiveQuery would compare the
  // stored query against the very same array and decide nothing changed.
  $: plainQuery.query(
    calendar.class.BusySlot,
    { person: { $in: [...participants] }, date: { $lte: dueDate }, dueDate: { $gte: date } },
    (res) => {
      plainSlots = res
    }
  )

  // A recurring slot's date/dueDate describe its first occurrence, so the window's start cannot
  // be applied server-side - but nothing starting after the window's end can occur inside it.
  $: recurringQuery.query(
    calendar.class.BusySlot,
    { person: { $in: [...participants] }, rules: { $exists: true }, date: { $lte: dueDate } },
    (res) => {
      recurringSlots = res
    }
  )

  $: slots = plainSlots
    .concat(recurringSlots)
    .filter((slot, idx, arr) => slot.eventId !== ignoreEventId && arr.findIndex((it) => it._id === slot._id) === idx)

  // getBusyIntervals clips to the window, so anything it returns overlaps the event.
  $: busyPersons = new Set(
    Array.from(getBusyIntervals(slots, date, dueDate).entries())
      .filter(([, intervals]) => intervals.length > 0)
      .map(([person]) => person)
  )
</script>
