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
  import { Person } from '@hcengineering/contact'
  import { Project } from '@hcengineering/task'
  import TeamCalendar from './TeamCalendar.svelte'
  import TeamCalendarDay from './TeamCalendarDay.svelte'
  import YearCalendar from './YearCalendar.svelte'
  import { Ref } from '@hcengineering/core'
  import Header from '../../Header.svelte'
  import {
    ButtonIcon,
    daysInMonth,
    DropdownLabels,
    DropdownLabelsIntl,
    IconSettings,
    SelectPopup,
    showPopup,
    type SelectPopupValueType
  } from '@hcengineering/ui'
  import time from '../../../plugin'

  export let spaces: Array<Ref<Project>> = []
  export let filterPersons: Array<Ref<Person>> = []
  export let currentDate: Date

  type Mode = 'day' | 'week' | 'month' | 'year'

  let mode: Mode = spaces.length === 1 ? 'day' : 'week'

  // Day-by-hour view is scoped to a single selected project only, fall back to week otherwise.
  $: if (spaces.length !== 1 && mode === 'day') mode = 'week'

  // The grid shows time and busy hours by default; everything else is opt-in per user.
  const extraKeys = ['planned', 'events', 'activity'] as const
  type ExtraKey = (typeof extraKeys)[number]
  const storageKey = 'team_calendar_extras'

  let extras: Record<ExtraKey, boolean> = readExtras()

  function readExtras (): Record<ExtraKey, boolean> {
    const stored = localStorage.getItem(storageKey)?.split(',') ?? []
    return {
      planned: stored.includes('planned'),
      events: stored.includes('events'),
      activity: stored.includes('activity')
    }
  }

  function toggleExtra (key: ExtraKey): void {
    extras = { ...extras, [key]: !extras[key] }
    localStorage.setItem(storageKey, extraKeys.filter((it) => extras[it]).join(','))
  }

  function showExtras (event: MouseEvent): void {
    const value: SelectPopupValueType[] = [
      { id: 'planned', label: time.string.Planned, isSelected: extras.planned },
      { id: 'events', label: time.string.ShowEvents, isSelected: extras.events },
      { id: 'activity', label: time.string.ShowActivity, isSelected: extras.activity }
    ]
    showPopup(SelectPopup, { value }, event.target as HTMLElement, (res) => {
      if (res != null) toggleExtra(res as ExtraKey)
    })
  }

  let timeMode: '1hour' | '30mins' | '15mins'

  $: modeItems = [
    ...(spaces.length === 1 ? [{ id: 'day', label: time.string.DayCalendar }] : []),
    { id: 'week', label: time.string.WeekCalendar },
    { id: 'month', label: time.string.MonthCalendar },
    { id: 'year', label: time.string.YearCalendar }
  ]

  // Month reuses the same PersonCalendar grid as week, just centered on the middle of the
  // month so maxDays = daysInMonth(currentDate) spans the whole month.
  $: monthPivot = new Date(currentDate.getFullYear(), currentDate.getMonth(), 16)
</script>

<Header bind:currentDate>
  {#if mode === 'day'}
    <DropdownLabels
      items={[
        { id: '1hour', label: '1 hour' },
        { id: '30mins', label: '30 mins' },
        { id: '15mins', label: '15 mins' }
      ]}
      bind:selected={timeMode}
      kind={'regular'}
      size={'medium'}
      showDropdownIcon
    />
  {/if}
  <DropdownLabelsIntl items={modeItems} bind:selected={mode} kind={'regular'} size={'medium'} />
  {#if mode === 'week' || mode === 'month'}
    <ButtonIcon icon={IconSettings} size={'small'} kind={'tertiary'} on:click={showExtras} />
  {/if}
  <div class="hulyHeader-divider short" />
</Header>

{#if mode === 'week'}
  <TeamCalendar
    {spaces}
    {filterPersons}
    {currentDate}
    showPlanned={extras.planned}
    showEvents={extras.events}
    showActivity={extras.activity}
  />
{:else if mode === 'month'}
  <TeamCalendar
    {spaces}
    {filterPersons}
    currentDate={monthPivot}
    maxDays={daysInMonth(currentDate)}
    detailed={false}
    showPlanned={extras.planned}
    showEvents={extras.events}
    showActivity={extras.activity}
  />
{:else if mode === 'day' && spaces.length === 1}
  <TeamCalendarDay space={spaces[0]} {currentDate} {timeMode} />
{:else if mode === 'year'}
  <YearCalendar {spaces} {filterPersons} {currentDate} />
{/if}
