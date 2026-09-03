<!--
// Copyright © 2022-2023 Hardcore Engineering Inc.
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
  import contact, { Employee, getCurrentEmployee } from '@hcengineering/contact'
  import { Class, Ref, Space, getCurrentAccount } from '@hcengineering/core'
  import { type IntlString } from '@hcengineering/platform'
  import presentation, { Card, createQuery, getClient } from '@hcengineering/presentation'
  import { UserBox } from '@hcengineering/contact-resources'
  import {
    Issue,
    type Project,
    TimeReportDayType,
    TimeSpendReport,
    TrackerEvents,
    formatDuration
  } from '@hcengineering/tracker'
  import {
    Button,
    DatePresenter,
    EditBox,
    IconChevronLeft,
    IconChevronRight,
    Label,
    themeStore
  } from '@hcengineering/ui'
  import { Analytics } from '@hcengineering/analytics'
  import tracker from '../../../plugin'
  import TitlePresenter from '../TitlePresenter.svelte'
  import { type ITimeReportService, DirectTimeReportService } from './service'
  import DurationInput from './DurationInput.svelte'

  export let issue: Issue | undefined = undefined
  export let issueId: Ref<Issue> | undefined = issue?._id
  export let issueClass: Ref<Class<Issue>> = issue?._class ?? tracker.class.Issue
  export let space: Ref<Space> | undefined = issue?.space
  export let assignee: Ref<Employee> | null | undefined = issue?.assignee as Ref<Employee>

  export let value: TimeSpendReport | undefined
  export let placeholder: IntlString = tracker.string.TimeSpendReportValue
  export let defaultTimeReportDay: TimeReportDayType = TimeReportDayType.CurrentWorkDay
  export let initialDate: number | undefined = undefined
  export let service: ITimeReportService | undefined = undefined

  let durationInput: DurationInput

  const data = {
    date: value?.date ?? initialDate ?? Date.now(),
    description: value?.description ?? '',
    value: value?.value,
    employee: value?.employee ?? getCurrentEmployee() ?? assignee ?? null
  }

  let isSpaceOwner = false
  const spaceQuery = createQuery()
  $: if (space !== undefined) {
    spaceQuery.query(
      tracker.class.Project,
      { _id: space as Ref<Project> },
      (res) => {
        const sp = res[0]
        const me = getCurrentAccount()
        isSpaceOwner = sp?.owners?.includes(me.uuid) ?? false
      },
      { limit: 1 }
    )
  }

  const myEmployee = getCurrentEmployee() ?? null
  $: isOwnReport = value === undefined || value.employee === myEmployee
  $: canEdit = isSpaceOwner || isOwnReport
  $: if (!isSpaceOwner && value === undefined) {
    data.employee = myEmployee
  }

  function dayBounds (ts: number): { start: number, end: number } {
    const d = new Date(ts)
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).valueOf()
    const end = start + 24 * 60 * 60 * 1000
    return { start, end }
  }

  let dayTotalHours = 0
  const dayReportsQuery = createQuery()
  $: if (data.employee != null && data.date != null) {
    const { start, end } = dayBounds(data.date)
    dayReportsQuery.query(
      tracker.class.TimeSpendReport,
      {
        employee: data.employee,
        date: { $gte: start, $lt: end }
      },
      (res) => {
        dayTotalHours = res
          .filter((r) => value === undefined || r._id !== value._id)
          .reduce((sum, r) => sum + (r.value ?? 0), 0)
      }
    )
  } else {
    dayTotalHours = 0
  }

  $: dayProjectedHours = dayTotalHours + (data.value ?? 0)

  function shiftDay (delta: number): void {
    const base = data.date != null ? new Date(data.date) : new Date()
    base.setDate(base.getDate() + delta)
    data.date = base.valueOf()
  }

  export function canClose (): boolean {
    return true
  }

  const client = getClient()

  async function create (): Promise<void> {
    const reportService = service ?? new DirectTimeReportService(client)
    if (value === undefined) {
      if (space && issueId) {
        await reportService.addReport(space, issueId, issueClass, data)
        Analytics.handleEvent(TrackerEvents.IssueTimeSpentAdded, { issue: issue?.identifier ?? issueId })
      }
    } else {
      await reportService.updateReport(value, data)
      Analytics.handleEvent(TrackerEvents.IssueTimeSpentUpdated, { issue: issue?.identifier ?? issueId })
    }
  }

  $: canSave = canEdit && data.value !== undefined && data.value !== 0 && space !== undefined && issueId !== undefined
</script>

<Card
  label={value === undefined ? tracker.string.TimeSpendReportAdd : tracker.string.TimeSpendReportValue}
  {canSave}
  okAction={create}
  gap={'gapV-4'}
  width={'medium'}
  thinHeader
  on:close
  okLabel={value === undefined ? presentation.string.Create : presentation.string.Save}
  on:changeContent
>
  <svelte:fragment slot="header">
    {#if issue}
      <TitlePresenter showParent={false} value={issue} />
    {/if}
  </svelte:fragment>
  <DurationInput bind:this={durationInput} bind:hours={data.value} readonly={!canEdit} />
  <div class="mt-2 mb-2">
    <EditBox
      bind:value={data.description}
      placeholder={tracker.string.TimeSpendReportDescription}
      kind={'editbox'}
      disabled={!canEdit}
    />
  </div>
  <svelte:fragment slot="footer">
    <div class="flex flex-col">
      <div class="flex flex-row-center gap-2">
        <div
          class="text-base"
          class:overReported={dayProjectedHours > 8}
          class:content-dark-color={dayProjectedHours <= 8}
        >
          <Label
            label={tracker.string.AlreadyReportedThisDay}
            params={{ hours: formatDuration(dayProjectedHours, $themeStore.language) }}
          />
        </div>
        {#if dayProjectedHours > 8 && canEdit}
          <Button
            kind={'regular'}
            size={'small'}
            label={tracker.string.FixToEightHours}
            on:click={() => {
              durationInput.setDurationText(Math.max(0, 8 - dayTotalHours))
            }}
          />
        {/if}
      </div>
    </div>
  </svelte:fragment>
  <svelte:fragment slot="pool">
    <div class="flex flex-grow flex-between">
      <UserBox
        _class={contact.mixin.Employee}
        label={contact.string.Employee}
        kind={'regular'}
        size={'large'}
        bind:value={data.employee}
        showNavigate={false}
        readonly={!isSpaceOwner || !canEdit}
      />
      <div class="flex-row-center gap-2">
        <div class="flex flex-row-center gap-1">
          <Button
            icon={IconChevronLeft}
            kind={'regular'}
            size={'large'}
            disabled={!canEdit}
            on:click={() => {
              shiftDay(-1)
            }}
          />
          <DatePresenter bind:value={data.date} editable={canEdit} kind={'regular'} size={'large'} />
          <Button
            icon={IconChevronRight}
            kind={'regular'}
            size={'large'}
            disabled={!canEdit}
            on:click={() => {
              shiftDay(1)
            }}
          />
        </div>
      </div>
    </div>
  </svelte:fragment>
</Card>

<style lang="scss">
  .overReported {
    color: var(--theme-error-color);
    font-weight: 500;
  }
</style>
