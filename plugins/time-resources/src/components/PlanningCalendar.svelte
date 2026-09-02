<script lang="ts">
  import calendar, {
    AccessLevel,
    BusySlot,
    Calendar,
    Event,
    generateEventId,
    getAllEvents,
    getBusyIntervals
  } from '@hcengineering/calendar'
  import { DayCalendar, calendarByIdStore, hidePrivateEvents } from '@hcengineering/calendar-resources'
  import contact, { Employee, Person, getCurrentEmployee, getName } from '@hcengineering/contact'
  import { UserBoxList, employeeByIdStore } from '@hcengineering/contact-resources'
  import { IdMap, PersonId, Ref, SortingOrder, Timestamp, getCurrentAccount } from '@hcengineering/core'
  import { IntlString, getEmbeddedLabel } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import {
    AnyComponent,
    ButtonBase,
    ButtonIcon,
    IconChevronLeft,
    IconChevronRight,
    Label,
    areDatesEqual,
    showPopup,
    ticker,
    Header,
    getFormattedDate,
    resizeObserver,
    deviceOptionsStore as deviceInfo
  } from '@hcengineering/ui'
  import { ToDo, WorkSlot } from '@hcengineering/time'
  import { PlannerCalendarMode } from '..'
  import time from '../plugin'
  import PlannerViewSwitch from './PlannerViewSwitch.svelte'
  import { getWorkSlotSpace } from '../utils'
  import IconSun from './icons/Sun.svelte'

  export let dragItem: ToDo | null = null
  export let currentDate: Date = new Date()
  export let displayedDaysCount = 1
  export let element: HTMLElement | undefined = undefined
  export let createComponent: AnyComponent | undefined = calendar.component.CreateEvent
  export let calMode: PlannerCalendarMode = 'personal'
  export let showToDos: boolean = true

  const q = createQuery()

  function getFrom (date: Date): Timestamp {
    return new Date(date).setHours(0, 0, 0, 0)
  }

  function getTo (date: Date, days: number = 3): Timestamp {
    return new Date(date).setDate(date.getDate() + days)
  }

  let dayCalendar: DayCalendar
  let raw: Event[] = []
  let objects: Event[] = []
  let showLabel: boolean = true

  const rem = (n: number): number => n * $deviceInfo.fontSize

  const myAcc = getCurrentAccount()
  const socialStrings = myAcc.socialIds
  const personalCalendar = `${myAcc.uuid}_calendar` as Ref<Calendar>

  const calendarsQ = createQuery()

  let calendars: Calendar[] = []
  let todayDate = new Date()

  $: calendarsQ.query(calendar.class.Calendar, { createdBy: { $in: socialStrings }, hidden: false }, (res) => {
    calendars = res
  })

  $: from = getFrom(currentDate)
  $: to = getTo(currentDate, displayedDaysCount)

  const extraPersonsKey = 'planner_extra_persons'
  let extraPersons: Array<Ref<Person>> = JSON.parse(localStorage.getItem(extraPersonsKey) ?? '[]')
  let showMine: boolean = localStorage.getItem('planner_show_mine') !== 'false'

  const hierarchy = getClient().getHierarchy()

  const busyQuery = createQuery()
  const busyRecurringQuery = createQuery()
  let busyPlain: BusySlot[] = []
  let busyRecurring: BusySlot[] = []

  // My own events are already on the grid in full detail, an extra busy block would double them.
  $: overlayPersons = extraPersons.filter((it) => it !== getCurrentEmployee())

  $: if (overlayPersons.length > 0) {
    busyQuery.query(
      calendar.class.BusySlot,
      { person: { $in: overlayPersons }, date: { $lte: to }, dueDate: { $gte: from } },
      (res) => {
        busyPlain = res
      }
    )
    // A recurring slot's date/dueDate describe its first occurrence, so the window's start
    // cannot be applied server-side - but nothing starting after `to` can occur inside it.
    busyRecurringQuery.query(
      calendar.class.BusySlot,
      { person: { $in: overlayPersons }, rules: { $exists: true }, date: { $lte: to } },
      (res) => {
        busyRecurring = res
      }
    )
  } else {
    busyQuery.unsubscribe()
    busyRecurringQuery.unsubscribe()
    busyPlain = []
    busyRecurring = []
  }

  // Colleagues' events live in their own PersonSpace and are unreadable here, only their
  // BusySlots are - so the overlay is synthetic: one freeBusy event per merged busy interval.
  function mkOverlay (
    person: Ref<Person>,
    interval: { date: Timestamp, dueDate: Timestamp },
    label: string,
    idx: number
  ): Event {
    return {
      _id: `busy-${person}-${label}-${idx}` as Ref<Event>,
      _class: calendar.class.Event,
      space: calendar.space.Calendar,
      attachedTo: calendar.ids.NoAttached,
      attachedToClass: calendar.class.Event,
      collection: 'events',
      modifiedBy: myAcc.primarySocialId,
      modifiedOn: interval.date,
      eventId: `busy-${person}-${label}-${idx}`,
      calendar: '' as Ref<Calendar>,
      title: label,
      description: '',
      date: interval.date,
      dueDate: interval.dueDate,
      allDay: false,
      blockTime: true,
      participants: [person],
      access: AccessLevel.Reader,
      visibility: 'freeBusy',
      user: '' as PersonId
    } as unknown as Event
  }

  function busyOverlay (slots: BusySlot[], from: Timestamp, to: Timestamp, employees: IdMap<Employee>): Event[] {
    const me = getCurrentEmployee()
    const unique = slots.filter(
      (slot, idx, arr) => slot.person !== me && arr.findIndex((it) => it._id === slot._id) === idx
    )
    const nameOf = (person: Ref<Person>): string => {
      const employee = employees.get(person as Ref<Employee>)
      return employee !== undefined ? getName(hierarchy, employee) : ''
    }
    const res: Event[] = []
    // A public event keeps its title on the slot, so it is shown by name instead of being merged
    // into the anonymous busy time around it.
    for (const slot of unique.filter((it) => (it.title ?? '') !== '')) {
      for (const [person, intervals] of getBusyIntervals([slot], from, to)) {
        intervals.forEach((interval, idx) => {
          res.push(mkOverlay(person, interval, slot.title ?? '', idx))
        })
      }
    }
    for (const [person, intervals] of getBusyIntervals(
      unique.filter((it) => (it.title ?? '') === ''),
      from,
      to
    )) {
      intervals.forEach((interval, idx) => {
        res.push(mkOverlay(person, interval, nameOf(person), idx))
      })
    }
    return res
  }

  $: overlay = busyOverlay(busyPlain.concat(busyRecurring), from, to, $employeeByIdStore)

  function update (calendars: Calendar[]): void {
    q.query<Event>(
      calendar.class.Event,
      { calendar: { $in: [personalCalendar, ...calendars.map((p) => p._id)] } },
      (result) => {
        raw = result
      },
      { sort: { date: SortingOrder.Ascending } }
    )
  }

  $: update(calendars)
  $: all = getAllEvents(raw, from, to)
  // Hiding my own schedule keeps the drag preview, there is nothing to drop onto otherwise.
  $: objects = showMine ? hidePrivateEvents(all, $calendarByIdStore) : all.filter((it) => it._id === dragItemId)

  function inc (val: number): void {
    if (val === 0) {
      currentDate = new Date()
      dayCalendar.scrollToTime(currentDate)
      return
    }
    currentDate.setDate(currentDate.getDate() + val)
    currentDate = currentDate
  }

  function getTitle (day: Date, now: Timestamp): IntlString {
    const today = new Date(now)
    const tomorrow = new Date(new Date(now).setDate(new Date(now).getDate() + 1))
    const yesterday = new Date(new Date(now).setDate(new Date(now).getDate() - 1))
    if (areDatesEqual(day, today)) return time.string.Today
    if (areDatesEqual(day, yesterday)) return time.string.Yesterday
    if (areDatesEqual(day, tomorrow)) return time.string.Tomorrow
    const isCurrentYear = day.getFullYear() === new Date().getFullYear()
    return getEmbeddedLabel(
      day.toLocaleDateString('default', {
        month: 'long',
        day: 'numeric',
        year: isCurrentYear ? undefined : 'numeric'
      })
    )
  }

  const dragItemId = 'drag_item' as Ref<WorkSlot>
  function dragEnter (e: CustomEvent<any>) {
    if (dragItem != null) {
      const current = raw.find((p) => p._id === dragItemId)
      if (current !== undefined) {
        current.attachedTo = dragItem._id
        current.attachedToClass = dragItem._class
        current.date = e.detail.date.getTime()
        current.dueDate = new Date(e.detail.date).setMinutes(new Date(e.detail.date).getMinutes() + 30)
      } else {
        const ev: WorkSlot = {
          _id: dragItemId,
          allDay: false,
          eventId: generateEventId(),
          title: '',
          description: '',
          access: AccessLevel.Owner,
          attachedTo: dragItem._id,
          attachedToClass: dragItem._class,
          _class: time.class.WorkSlot,
          collection: 'events',
          visibility: 'public',
          blockTime: true,
          calendar: personalCalendar,
          space: getWorkSlotSpace(dragItem),
          modifiedBy: myAcc.primarySocialId,
          participants: [getCurrentEmployee()],
          modifiedOn: Date.now(),
          date: e.detail.date.getTime(),
          dueDate: new Date(e.detail.date).setMinutes(new Date(e.detail.date).getMinutes() + 30),
          user: myAcc.primarySocialId
        }
        raw.push(ev)
      }
      raw = raw
      all = getAllEvents(raw, from, to)
      objects = showMine ? hidePrivateEvents(all, $calendarByIdStore) : all.filter((it) => it._id === dragItemId)
    }
  }
  function dragLeave (event: DragEvent) {
    const rect = dayCalendar.getCalendarRect()
    if (!rect) return
    if (event.x < rect.left || event.x > rect.right || event.y < rect.top || event.y > rect.bottom) {
      raw = raw.filter((r) => r._id !== dragItemId)
    }
  }
  function dragOut () {
    if (dragItemId != null) {
      raw = raw.filter((r) => r._id !== dragItemId)
    }
  }

  function clear (dragItem: ToDo | null) {
    if (dragItem === null) {
      raw = raw.filter((p) => p._id !== dragItemId)
      all = getAllEvents(raw, from, to)
      objects = showMine ? hidePrivateEvents(all, $calendarByIdStore) : all.filter((it) => it._id === dragItemId)
    }
  }
  $: clear(dragItem)

  function showCreateDialog (date: Date, withTime: boolean) {
    if (createComponent === undefined) {
      return
    }
    showPopup(createComponent, { date, withTime }, 'top')
  }

  $: isToday = areDatesEqual(currentDate, new Date($ticker))
</script>

<div
  class="hulyComponent modal"
  bind:this={element}
  use:resizeObserver={(element) => {
    showLabel = showLabel ? element.clientWidth > rem(3.5) + 399 : element.clientWidth > rem(3.5) + 400
  }}
>
  <Header adaptive={'disabled'}>
    <PlannerViewSwitch bind:calMode bind:showToDos />
    <!-- On a narrow panel the day columns already carry the date, and the heading would push
         the actions out of the header. -->
    {#if showLabel}
      <div class="heading-medium-20 line-height-auto overflow-label">
        <Label label={getTitle(currentDate, $ticker)} />
      </div>
    {/if}
    <svelte:fragment slot="actions">
      <ButtonIcon
        icon={contact.icon.Person}
        kind={'secondary'}
        size={'small'}
        pressed={showMine}
        tooltip={{ label: time.string.Schedule }}
        on:click={() => {
          showMine = !showMine
          localStorage.setItem('planner_show_mine', showMine ? 'true' : 'false')
        }}
      />
      <UserBoxList
        items={extraPersons}
        docQuery={{ _id: { $nin: [getCurrentEmployee()] } }}
        kind={'regular'}
        size={'small'}
        on:update={(e) => {
          extraPersons = e.detail
          localStorage.setItem(extraPersonsKey, JSON.stringify(extraPersons))
        }}
      />
      <ButtonIcon
        icon={IconChevronLeft}
        kind={'secondary'}
        size={'small'}
        on:click={() => {
          inc(-1)
        }}
      />
      <ButtonBase
        icon={IconSun}
        label={showLabel ? time.string.TodayColon : undefined}
        title={showLabel ? getFormattedDate(todayDate.getTime(), { weekday: 'short', day: 'numeric' }) : undefined}
        type={showLabel ? 'type-button' : 'type-button-icon'}
        kind={'secondary'}
        size={'small'}
        inheritFont
        hasMenu
        disabled={isToday}
        on:click={() => {
          inc(0)
        }}
      />
      <ButtonIcon
        icon={IconChevronRight}
        kind={'secondary'}
        size={'small'}
        on:click={() => {
          inc(1)
        }}
      />
    </svelte:fragment>
  </Header>
  <div class="hulyComponent-content__container">
    <DayCalendar
      bind:this={dayCalendar}
      events={objects}
      backgroundEvents={overlay}
      bind:displayedDaysCount
      startFromWeekStart={false}
      clearCells={dragItem !== null}
      {dragItemId}
      on:dragEnter={dragEnter}
      on:dragOut={dragOut}
      on:dragleave={dragLeave}
      on:create={(e) => {
        showCreateDialog(e.detail.date, e.detail.withTime)
      }}
      on:dragDrop
      bind:currentDate
      bind:todayDate
    />
  </div>
</div>

<style lang="scss">
  .title {
    padding: 1.75rem 2rem;
    font-size: 1.25rem;
    color: var(--theme-caption-color);
  }

  .tools {
    padding: 0 2rem 0.75rem;
  }
</style>
