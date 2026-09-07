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

<script lang="ts">
  import { createEventDispatcher, afterUpdate, onDestroy, tick } from 'svelte'
  import { AccessLevel, generateEventId, getPrimaryCalendar } from '@hcengineering/calendar'
  import { getCurrentEmployee } from '@hcengineering/contact'
  import { Ref, getCurrentAccount } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { TagElement } from '@hcengineering/tags'
  import { Separator, defineSeparators, deviceOptionsStore as deviceInfo } from '@hcengineering/ui'
  import { PlannerCalendarMode, ToDosMode } from '..'
  import PlanningCalendar from './PlanningCalendar.svelte'
  import ToDosNavigator from './ToDosNavigator.svelte'
  import TeamContent from './team/TeamContent.svelte'
  import ToDos from './ToDos.svelte'
  import { findPrimaryCalendar, getWorkSlotSpace, timeSeparators, timeSeparatorsNoToDos } from '../utils'
  import { dragging } from '../dragging'
  import time from '../plugin'
  import { Analytics } from '@hcengineering/analytics'
  import { TimeEvents } from '@hcengineering/time'

  const dispatch = createEventDispatcher()

  const defaultDuration = 30 * 60 * 1000
  let mainPanel: HTMLElement
  let replacedPanel: HTMLElement

  let currentDate: Date = new Date()

  $: dragItem = $dragging.item
  $: visibleCalendar = $deviceInfo.docWidth > 800

  const client = getClient()

  async function drop (e: CustomEvent<any>) {
    if (dragItem === null) return
    const doc = dragItem
    const date = e.detail.date.getTime()
    const currentAccount = getCurrentAccount()
    const _calendar = await findPrimaryCalendar()
    const dueDate = date + defaultDuration
    await client.addCollection(time.class.WorkSlot, getWorkSlotSpace(doc), doc._id, doc._class, 'workslots', {
      calendar: _calendar,
      eventId: generateEventId(),
      date,
      dueDate,
      description: doc.description,
      participants: [getCurrentEmployee()],
      title: doc.title,
      allDay: false,
      blockTime: true,
      access: AccessLevel.Owner,
      visibility: doc.visibility === 'public' ? 'public' : 'freeBusy',
      reminders: [],
      user: currentAccount.primarySocialId
    })
    Analytics.handleEvent(TimeEvents.ToDoScheduled, { id: doc._id })
  }

  const todoModes: ToDosMode[] = ['unplanned', 'planned', 'all', 'tag', 'date']
  const storedMode = localStorage.getItem('todos_last_mode') as ToDosMode
  let mode: ToDosMode = todoModes.includes(storedMode) ? storedMode : 'unplanned'

  const storedCalMode = localStorage.getItem('planner_calendar_mode') as PlannerCalendarMode
  let calMode: PlannerCalendarMode = ['personal', 'team-calendar', 'team'].includes(storedCalMode)
    ? storedCalMode
    : 'personal'
  // The todo list is worth its width next to my own schedule, the team views want the room.
  function showToDosFor (value: PlannerCalendarMode): boolean {
    const stored = localStorage.getItem(`planner_show_todos_${value}`)
    return stored === null ? value === 'personal' : stored === 'true'
  }

  let showToDos: boolean = showToDosFor(calMode)

  // The separator between the todo list and the calendar leaves an inline width on the calendar
  // panel and does not clear it when it unmounts, so the panel would keep the narrow size it had
  // next to the list. Its own siblings are resolved asynchronously, hence the tick.
  let panelWidthOwner: boolean = showToDos
  $: if (!showToDos && panelWidthOwner) {
    panelWidthOwner = false
    void tick().then(() => {
      if (replacedPanel === undefined) return
      replacedPanel.style.minWidth = ''
      replacedPanel.style.maxWidth = ''
      replacedPanel.style.width = ''
      replacedPanel.removeAttribute('data-size')
    })
  } else if (showToDos) {
    panelWidthOwner = true
  }
  // Each layout keeps its own separator set, so switching does not reset the other's widths.
  $: separatorName = showToDos ? 'time' : 'time-no-todos'
  $: defineSeparators(separatorName, showToDos ? timeSeparators : timeSeparatorsNoToDos)
  let shownFor: PlannerCalendarMode = calMode
  $: if (calMode !== shownFor) {
    shownFor = calMode
    showToDos = showToDosFor(calMode)
  }
  let tag: Ref<TagElement> | undefined = (localStorage.getItem('todos_last_tag') as Ref<TagElement>) ?? undefined

  dispatch('change', true)
  afterUpdate(() => {
    $deviceInfo.replacedPanel = replacedPanel ?? mainPanel
  })
  onDestroy(() => ($deviceInfo.replacedPanel = undefined))
</script>

{#if $deviceInfo.navigator.visible}
  <ToDosNavigator bind:mode bind:tag bind:currentDate {separatorName} />
  <Separator name={separatorName} float={$deviceInfo.navigator.float} index={0} color={'var(--theme-divider-color)'} />
{/if}
{#if showToDos}
  <div
    class="flex-col w-full clear-mins mobile-wrapper"
    class:left-divider={!$deviceInfo.navigator.visible}
    class:right-divider={!visibleCalendar}
    bind:this={mainPanel}
  >
    <ToDos {mode} {tag} bind:currentDate />
  </div>
  {#if visibleCalendar}
    <Separator name={separatorName} index={1} color={'transparent'} separatorSize={0} short />
  {/if}
{/if}
<!-- With the todo list hidden the calendar is the only panel left, so it stays visible even on narrow screens. -->
{#if visibleCalendar || !showToDos}
  {#if calMode === 'personal'}
    <PlanningCalendar
      {dragItem}
      bind:element={replacedPanel}
      bind:currentDate
      bind:calMode
      bind:showToDos
      displayedDaysCount={5}
      on:dragDrop={drop}
    />
  {:else}
    <div class="flex-col w-full clear-mins" bind:this={replacedPanel}>
      <TeamContent bind:calMode bind:showToDos bind:currentDate />
    </div>
  {/if}
{/if}
