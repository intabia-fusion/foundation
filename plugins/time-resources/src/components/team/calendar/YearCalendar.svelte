<!--
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
-->
<script lang="ts">
  import calendar, { BusySlot, getBusyIntervals } from '@hcengineering/calendar'
  import contact, { Person } from '@hcengineering/contact'
  import { employeeRefByAccountUuidStore, PersonPresenter } from '@hcengineering/contact-resources'
  import { Ref, Timestamp } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import task, { Project } from '@hcengineering/task'
  import { getMonthName, Scroller } from '@hcengineering/ui'
  import TimePresenter from '../../presenters/TimePresenter.svelte'

  export let spaces: Array<Ref<Project>> = []
  export let filterPersons: Array<Ref<Person>> = []
  export let currentDate: Date

  $: year = currentDate.getFullYear()

  const projectsQuery = createQuery()
  let projects: Project[] = []
  $: if (spaces.length > 0) {
    projectsQuery.query(task.class.Project, { _id: { $in: spaces } }, (res) => {
      projects = res
    })
  } else {
    projectsQuery.unsubscribe()
    projects = []
  }

  const activeEmployeesQuery = createQuery()
  let activeEmployees: Array<Ref<Person>> = []
  $: if (spaces.length === 0) {
    activeEmployeesQuery.query(contact.mixin.Employee, { active: true }, (res) => {
      activeEmployees = res.map((e) => e._id)
    })
  } else {
    activeEmployeesQuery.unsubscribe()
  }

  $: memberRefs =
    spaces.length === 0
      ? activeEmployees
      : projects
        .flatMap((p) => p.members ?? [])
        .map((it) => $employeeRefByAccountUuidStore.get(it))
        .filter((it) => it !== undefined)

  $: persons = filterPersons.length > 0 ? memberRefs.filter((it) => filterPersons.includes(it)) : memberRefs

  $: yearFrom = new Date(year, 0, 1).getTime()
  $: yearTo = new Date(year + 1, 0, 1).getTime()

  // A whole year, all employees is a heavy query - only fires while this component is mounted
  // (i.e. the year mode is actually selected) and there is at least one row to show.
  const busyQuery = createQuery()
  let busySlots: BusySlot[] = []
  $: if (persons.length > 0) {
    busyQuery.query(
      calendar.class.BusySlot,
      { person: { $in: persons }, date: { $lt: yearTo }, dueDate: { $gt: yearFrom } },
      (res) => {
        busySlots = res
      }
    )
  } else {
    busyQuery.unsubscribe()
    busySlots = []
  }

  interface MonthBucket {
    from: Timestamp
    to: Timestamp
    label: string
    intervals: Map<Ref<Person>, Array<{ date: Timestamp, dueDate: Timestamp }>>
  }

  $: months = Array.from({ length: 12 }, (_, m): MonthBucket => {
    const from = new Date(year, m, 1).getTime()
    const to = new Date(year, m + 1, 1).getTime()
    return {
      from,
      to,
      label: getMonthName(new Date(year, m, 1), 'short'),
      intervals: getBusyIntervals(busySlots, from, to)
    }
  })

  function busyOf (person: Ref<Person>, month: MonthBucket): number {
    const intervals = month.intervals.get(person) ?? []
    return intervals.reduce((sum, it) => sum + (it.dueDate - it.date), 0)
  }

  function ratioOf (person: Ref<Person>, month: MonthBucket): number {
    return Math.min(1, busyOf(person, month) / (month.to - month.from))
  }
</script>

<Scroller>
  <div class="year-grid">
    <div class="year-cell year-header year-person-col" />
    {#each months as month}
      <div class="year-cell year-header">{month.label}</div>
    {/each}
    {#each persons as person (person)}
      <div class="year-cell year-person-col"><PersonPresenter value={person} /></div>
      {#each months as month (month.from)}
        {@const busy = busyOf(person, month)}
        <div
          class="year-cell"
          style:background="color-mix(in srgb, var(--positive-button-default) {Math.round(
            ratioOf(person, month) * 60
          )}%, transparent)"
        >
          {#if busy > 0}
            <TimePresenter value={busy} />
          {/if}
        </div>
      {/each}
    {/each}
  </div>
</Scroller>

<style lang="scss">
  .year-grid {
    display: grid;
    grid-template-columns: 12rem repeat(12, minmax(4.5rem, 1fr));
    width: 100%;
  }
  .year-cell {
    display: flex;
    align-items: center;
    padding: 0.5rem;
    min-height: 2.5rem;
    border-bottom: 1px solid var(--theme-bg-divider-color);
    border-right: 1px solid var(--theme-bg-divider-color);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .year-header {
    font-weight: 500;
    background-color: var(--theme-comp-header-color);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .year-person-col {
    position: sticky;
    left: 0;
    background-color: var(--theme-comp-header-color);
    z-index: 1;
  }
</style>
