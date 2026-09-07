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
  import calendar from '@hcengineering/calendar'
  import { DateRangeMode, Timestamp } from '@hcengineering/core'
  import { DatePresenter, Label } from '@hcengineering/ui'
  import { EventPersonMapping } from '../../../types'
  import TimePresenter from '../../presenters/TimePresenter.svelte'

  export let gitem: EventPersonMapping | undefined
  export let dayFrom: Timestamp
  export let dayTo: Timestamp
  export let maxRows = 3
  // Working hours the bar spans by default; it stretches if the day runs outside them.
  export let workdayStart = 8
  export let workdayEnd = 20

  interface Entry {
    date: Timestamp
    dueDate: Timestamp
    title?: string
  }

  // Everything the day holds, named where we are allowed to name it.
  $: entries = (
    gitem === undefined
      ? []
      : [
          ...gitem.mappings.flatMap((m) =>
            m.slots.map((s) => ({ date: s.date, dueDate: s.dueDate, title: m.todo?.title }))
          ),
          ...gitem.events.map((e) => ({ date: e.date, dueDate: e.dueDate, title: e.title })),
          ...gitem.busy.slots.map((s) => ({ date: s.date, dueDate: s.dueDate })),
          ...gitem.busyEvents.map((e) => ({ date: e.date, dueDate: e.dueDate })),
          ...gitem.busySlots.map((s) => ({ date: s.date, dueDate: s.dueDate }))
        ]
  )
    .filter((it) => it.dueDate > dayFrom && it.date < dayTo)
    .sort((a, b) => a.date - b.date) as Entry[]

  $: visible = entries.slice(0, maxRows)
  $: hidden = entries.length - visible.length

  const hour = 60 * 60 * 1000

  // The bar covers the working day, widened to whatever actually falls outside it -
  // over a full 24h scale an evening meeting would be a sliver pinned to the edge.
  $: barFrom = Math.min(dayFrom + workdayStart * hour, ...entries.map((it) => it.date))
  $: barTo = Math.max(dayFrom + workdayEnd * hour, ...entries.map((it) => it.dueDate))

  function offset (time: Timestamp): number {
    const clamped = Math.min(barTo, Math.max(barFrom, time))
    return ((clamped - barFrom) / (barTo - barFrom)) * 100
  }

  function hourLabel (time: Timestamp): string {
    return new Date(time).getHours().toString().padStart(2, '0')
  }
</script>

{#if entries.length > 0}
  <div class="bar-row flex-row-center">
    <span class="edge">{hourLabel(barFrom)}</span>
    <div class="day-bar">
      {#each entries as entry}
        <div
          class="segment"
          class:named={entry.title !== undefined}
          style="left: {offset(entry.date)}%; width: {Math.max(2, offset(entry.dueDate) - offset(entry.date))}%"
        />
      {/each}
    </div>
    <span class="edge">{hourLabel(barTo)}</span>
  </div>
  {#each visible as entry}
    <div class="entry flex-between" title={entry.title ?? ''}>
      <div class="flex-row-center flex-gap-1 min-w-0">
        <DatePresenter mode={DateRangeMode.TIMEONLY} value={entry.date} />
        <span class="overflow-label">
          {#if entry.title !== undefined}{entry.title}{:else}<Label label={calendar.string.Busy} />{/if}
        </span>
      </div>
      <span class="flex-no-shrink ml-1"><TimePresenter value={entry.dueDate - entry.date} /></span>
    </div>
  {/each}
  {#if hidden > 0}
    <div class="entry more">+{hidden}</div>
  {/if}
{/if}

<style lang="scss">
  .bar-row {
    margin: 0.25rem 0.25rem 0.375rem;
    gap: 0.25rem;
  }
  .edge {
    font-size: 0.5625rem;
    color: var(--theme-dark-color);
    flex-shrink: 0;
  }
  .day-bar {
    position: relative;
    flex-grow: 1;
    height: 0.5rem;
    border-radius: 0.25rem;
    // Free time reads as empty space, busy intervals are drawn into it.
    background-color: var(--theme-button-default);
    border: 1px solid var(--theme-divider-color);
    overflow: hidden;
  }
  .segment {
    position: absolute;
    top: 0;
    height: 100%;
    background-color: var(--theme-divider-color);

    &.named {
      background-color: var(--primary-button-default);
    }
  }
  .entry {
    padding: 0 0.25rem;
    font-size: 0.6875rem;
    color: var(--theme-content-color);
    min-width: 0;
  }
  .more {
    color: var(--theme-dark-color);
  }
</style>
