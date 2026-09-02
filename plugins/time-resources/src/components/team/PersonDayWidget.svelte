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
  import { BusySlot, Event, getAllEvents } from '@hcengineering/calendar'
  import { Person } from '@hcengineering/contact'
  import { PersonPresenter } from '@hcengineering/contact-resources'
  import { IdMap, Ref } from '@hcengineering/core'
  import { Project } from '@hcengineering/task'
  import { ToDo, WorkSlot } from '@hcengineering/time'
  import { getResource } from '@hcengineering/platform'
  import { ButtonIcon, IconClose, Label } from '@hcengineering/ui'
  import workbench, { Widget } from '@hcengineering/workbench'
  import time from '../../plugin'
  import DayPlan from './agenda/DayPlan.svelte'
  import WithTeamData from './WithTeamData.svelte'
  import { toSlots } from './utils'

  // Sidebar widgets are rendered with the widget state; ours carries the person and the day.
  export let widgetState: { data?: { person?: Ref<Person>, date?: number } } | undefined = undefined
  export let widget: Widget | undefined = undefined

  // closeWidget resolved via getResource - no direct workbench-resources import (package cycle)
  async function handleClose (): Promise<void> {
    if (widget === undefined) return
    const closeWidget = await getResource(workbench.function.CloseWidget)
    await closeWidget(widget._id)
  }

  $: person = widgetState?.data?.person
  $: date = widgetState?.data?.date ?? Date.now()
  $: dayFrom = new Date(date).setHours(0, 0, 0, 0)
  $: dayTo = new Date(dayFrom).setHours(23, 59, 59, 999)

  let slots: WorkSlot[] = []
  let events: Event[] = []
  let busySlots: BusySlot[] = []
  let todos: IdMap<ToDo> = new Map()
  const spaces: Array<Ref<Project>> = []

  $: persons = person !== undefined ? [person] : []
  $: daySlots = toSlots(getAllEvents(slots, dayFrom, dayTo))
  $: dayEvents = getAllEvents(events, dayFrom, dayTo)
</script>

{#if person !== undefined}
  <WithTeamData {spaces} fromDate={dayFrom} toDate={dayTo} {persons} bind:todos bind:slots bind:events bind:busySlots />
  <div class="p-4">
    <div class="fs-title mb-2 flex-between">
      <PersonPresenter value={person} shouldShowAvatar shouldShowName />
      {#if widget !== undefined}
        <ButtonIcon icon={IconClose} size={'small'} kind={'tertiary'} on:click={handleClose} />
      {/if}
    </div>
    <DayPlan
      day={new Date(dayFrom)}
      slots={daySlots}
      events={dayEvents}
      {busySlots}
      {todos}
      from={dayFrom}
      to={dayTo}
    />
  </div>
{:else}
  <div class="p-4"><Label label={time.string.Team} /></div>
{/if}
