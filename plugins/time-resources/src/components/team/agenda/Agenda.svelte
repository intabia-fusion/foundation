<script lang="ts">
  import { BusySlot, Event, getAllEvents } from '@hcengineering/calendar'
  import contact, { Person } from '@hcengineering/contact'
  import { IdMap, Ref } from '@hcengineering/core'
  import { Project } from '@hcengineering/task'
  import { ToDo, WorkSlot } from '@hcengineering/time'
  import Border from '../../Border.svelte'
  import Header from '../../Header.svelte'
  import WithTeamData from '../WithTeamData.svelte'
  import { toSlots } from '../utils'
  import DayPlan from './DayPlan.svelte'
  import { createQuery } from '@hcengineering/presentation'
  import { employeeRefByAccountUuidStore } from '@hcengineering/contact-resources'

  export let spaces: Ref<Project>[] = []
  export let filterPersons: Ref<Person>[] = []
  export let currentDate: Date

  $: today = new Date(currentDate)
  $: yesterday = new Date(new Date(today).setDate(today.getDate() - 1))
  $: tomorrow = new Date(new Date(today).setDate(today.getDate() + 1))
  $: dayAfterTomorrow = new Date(new Date(tomorrow).setDate(tomorrow.getDate() + 1))
  $: yesterdayFrom = new Date(yesterday).setHours(0, 0, 0, 0)
  $: yesterdayTo = new Date(today).setHours(0, 0, 0, 0)
  $: todayFrom = new Date(today).setHours(0, 0, 0, 0)
  $: todayTo = new Date(tomorrow).setHours(0, 0, 0, 0)
  $: tomorrowFrom = todayTo
  $: tomorrowTo = new Date(dayAfterTomorrow).setHours(0, 0, 0, 0)

  let projects: Project[] = []
  let slots: WorkSlot[] = []
  let events: Event[] = []
  let todos: IdMap<ToDo> = new Map()
  let busySlots: BusySlot[] = []

  $: yesterdaySlots = toSlots(getAllEvents(slots, yesterdayFrom, yesterdayTo))
  $: yesterdayEvents = getAllEvents(events, yesterdayFrom, yesterdayTo)

  $: yesterdayEventsMap = new Map(yesterdayEvents.map((e) => [e._id, e]))

  $: todaySlots = toSlots(getAllEvents(slots, todayFrom, todayTo))
  $: todayEvents = getAllEvents(
    events.filter((it) => !yesterdayEventsMap.has(it._id)),
    todayFrom,
    todayTo
  )

  $: todayEventsMap = new Map(todayEvents.map((e) => [e._id, e]))

  $: tomorrowSlots = toSlots(getAllEvents(slots, tomorrowFrom, tomorrowTo))
  $: tomorrowEvents = getAllEvents(
    events.filter((it) => !yesterdayEventsMap.has(it._id) && !todayEventsMap.has(it._id)),
    tomorrowFrom,
    tomorrowTo
  )

  // No project selected - fall back to all active employees of the platform.
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
</script>

<WithTeamData
  {spaces}
  fromDate={yesterdayFrom}
  toDate={tomorrowTo}
  bind:projects
  bind:todos
  bind:slots
  bind:events
  bind:busySlots
  {persons}
/>

<Header bind:currentDate />
<div class="flex-row-top background-body-color h-full">
  <div class="item flex-col">
    <DayPlan
      day={yesterday}
      slots={yesterdaySlots}
      events={yesterdayEvents}
      {busySlots}
      from={yesterdayFrom}
      to={yesterdayTo}
      showAssignee
      {todos}
    />
  </div>
  <div class="flex-no-shrink">
    <Border />
  </div>
  <div class="item flex-col">
    <DayPlan
      day={today}
      slots={todaySlots}
      events={todayEvents}
      {busySlots}
      from={todayFrom}
      to={todayTo}
      showAssignee
      {todos}
    />
  </div>
  <div class="flex-no-shrink">
    <Border />
  </div>
  <div class="item flex-col">
    <DayPlan
      day={tomorrow}
      slots={tomorrowSlots}
      events={tomorrowEvents}
      {busySlots}
      from={tomorrowFrom}
      to={tomorrowTo}
      showAssignee
      {todos}
    />
  </div>
</div>

<style lang="scss">
  .item {
    flex-shrink: 0;
    flex-grow: 1;
    width: 33.33%;
    height: 100%;
    // margin: 2rem;
  }
</style>
