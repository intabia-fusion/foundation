<!--
// Copyright © 2026 Intabia Fusion
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
  import { DocumentQuery, IdMap, PersonId, Ref, toIdMap } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import { Issue, TimeSpendReport } from '@hcengineering/tracker'
  import tracker from '../../../plugin'
  import PersonCalendar from './PersonCalendar.svelte'
  import { Person } from '@hcengineering/contact'
  import {
    Button,
    ButtonIcon,
    DropdownLabelsIntl,
    Icon,
    IconAdd,
    IconCircleAdd,
    Label,
    ModernToggle,
    daysInMonth,
    deviceOptionsStore as deviceInfo,
    showPopup
  } from '@hcengineering/ui'
  import TimePresenter from './TimePresenter.svelte'
  import TimeReportHeader from './TimeReportHeader.svelte'
  import IssuePresenter from '../IssuePresenter.svelte'
  import EstimationPopup from './EstimationPopup.svelte'
  import PersonReportsPopup from './PersonReportsPopup.svelte'
  import { getPersonRefsByPersonIdsCb } from '@hcengineering/contact-resources'
  import IssueStatusPresenter from '../IssueStatusPresenter.svelte'

  export let query: DocumentQuery<Issue> = {}

  const issueQuery = createQuery()

  let issues: IdMap<Issue> = new Map()

  let issuesDayMap = new Map<number, Ref<Issue>[]>()
  let reports: TimeSpendReport[] = []
  let authors: PersonId[] = []

  $: issueQuery.query(
    tracker.class.Issue,
    { ...query },
    (res) => {
      issues = toIdMap(res)
      const reps = res.map((it) => (it.$lookup?.reports as TimeSpendReport[]) ?? []).flat()
      reps.sort((a, b) => (b.date ?? b.createdOn ?? 0) - (a.date ?? a.createdOn ?? 0))
      reports = reps

      authors = Array.from(new Set([...res.map((it) => it.createdBy), ...res.map((it) => it.modifiedBy)])).filter(
        (it) => it !== undefined
      )

      if (!onlyReports) {
        const _dayMap = new Map<number, Ref<Issue>[]>()

        for (const is of res) {
          let day = new Date(is.createdOn ?? 0).setHours(0, 0, 0, 0)
          _dayMap.set(day, Array.from(new Set([...(_dayMap.get(day) ?? []), is._id])))

          day = new Date(is.modifiedOn ?? 0).setHours(0, 0, 0, 0)
          _dayMap.set(day, Array.from(new Set([...(_dayMap.get(day) ?? []), is._id])))
        }

        issuesDayMap = _dayMap
      } else {
        issuesDayMap = new Map<number, Ref<Issue>[]>()
      }
    },
    {
      projection: {
        _class: 1,
        title: 1,
        identifier: 1,
        status: 1,
        modifiedOn: 1,
        createdOn: 1,
        createdBy: 1,
        modifiedBy: 1
      },
      lookup: {
        _id: {
          reports: tracker.class.TimeSpendReport
        }
      }
    }
  )

  let currentDate: Date = new Date()
  type RangeMode = 'week' | 'twoWeeks' | 'month'
  let rangeMode: RangeMode = 'week'

  $: firstDayOfWeek = $deviceInfo.firstDayOfWeek ?? 1
  $: periodStart = rangeMode === 'month' ? startOfMonth(currentDate) : startOfWeek(currentDate, firstDayOfWeek)
  $: periodEndMs = getPeriodEndMs(periodStart, rangeMode)

  $: periodReports = reports.filter(
    (it) => it.date != null && it.date >= periodStart.getTime() && it.date <= periodEndMs
  )

  $: reportPersons = Array.from(
    (periodReports.filter((it) => it.employee != null).map((it) => it.employee) as Ref<Person>[]) ?? []
  )

  let authorRefs = new Map<PersonId, Ref<Person>>()

  $: getPersonRefsByPersonIdsCb(authors, (res) => {
    authorRefs = res
  })

  $: noEmployeeReports = periodReports.filter((it) => it.employee == null)

  const onlyReportsKey = '#tracker:onlyReports'
  let onlyReports = localStorage.getItem(onlyReportsKey) !== 'false'
  $: localStorage.setItem(onlyReportsKey, String(onlyReports))

  $: finalPersons = [...(noEmployeeReports.length > 0 ? [null] : []), ...Array.from(new Set(reportPersons))]

  let rangeSelected: string | number | undefined = 'week'

  function toRangeMode (value: string | number | undefined): RangeMode {
    switch (value) {
      case 'week':
      case 'twoWeeks':
      case 'month':
        return value
      default:
        return 'week'
    }
  }

  $: rangeMode = toRangeMode(rangeSelected)

  function startOfWeek (date: Date, weekStartsOn: number): Date {
    const result = new Date(date)
    result.setHours(0, 0, 0, 0)
    const diff = (result.getDay() - weekStartsOn + 7) % 7
    result.setDate(result.getDate() - diff)
    return result
  }

  function startOfMonth (date: Date): Date {
    const result = new Date(date)
    result.setHours(0, 0, 0, 0)
    result.setDate(1)
    return result
  }

  function getPeriodEndMs (periodStart: Date, mode: RangeMode): number {
    const nextPeriodStart = new Date(periodStart)
    if (mode === 'month') {
      nextPeriodStart.setMonth(nextPeriodStart.getMonth() + 1)
    } else {
      nextPeriodStart.setDate(nextPeriodStart.getDate() + (mode === 'week' ? 7 : 14))
    }
    return nextPeriodStart.getTime() - 1
  }

  $: periodDays = rangeMode === 'week' ? 7 : rangeMode === 'twoWeeks' ? 14 : daysInMonth(currentDate)
  $: navStep = (rangeMode === 'week' ? 7 : rangeMode === 'twoWeeks' ? 14 : 'month') as number | 'month'

  $: periodTotal = periodReports.reduce((a, b) => a + b.value, 0)
</script>

<TimeReportHeader bind:currentDate step={navStep}>
  <ModernToggle label={tracker.string.TimeSpendReports} bind:checked={onlyReports} />
  <DropdownLabelsIntl
    items={[
      { id: 'week', label: tracker.string.TimeRangeWeek },
      { id: 'twoWeeks', label: tracker.string.TimeRangeTwoWeeks },
      { id: 'month', label: tracker.string.TimeRangeMonth }
    ]}
    bind:selected={rangeSelected}
    kind={'regular'}
    size={'medium'}
  />
  <div class="flex-row-center gap-1 ml-2">
    <span class="content-dark-color text-sm"><Label label={tracker.string.TimeRangePeriodTotal} />:</span>
    <span class="fs-title"><TimePresenter value={periodTotal} /></span>
  </div>
  <div class="hulyHeader-divider short" />
</TimeReportHeader>
<PersonCalendar
  persons={finalPersons}
  {currentDate}
  startDate={periodStart}
  maxDays={periodDays}
  minColWidthRem={onlyReports ? 3 : 8}
  anchor={'start'}
  rowHeightRem={onlyReports ? 3 : 8}
  personInfoInline={onlyReports}
>
  <svelte:fragment slot="person-info" let:person let:leftDay let:rightDay>
    {@const ld = new Date(leftDay).setHours(0, 0, 0, 0)}
    {@const rd = new Date(rightDay).setHours(23, 59, 59, 999)}
    {@const allReports = reports.filter(
      (it) => it.employee === person && it.date != null && ld <= it.date && it.date <= rd
    )}
    <Button
      kind={'link'}
      on:click={() => {
        showPopup(PersonReportsPopup, { person, ld, rd })
      }}
    >
      <svelte:fragment slot="content">
        <TimePresenter value={allReports.reduce((a, b) => a + b.value, 0)} />
      </svelte:fragment>
    </Button>
  </svelte:fragment>
  <svelte:fragment slot="day" let:day let:person let:height>
    {@const dayFrom = new Date(day).setHours(0, 0, 0, 0)}
    {@const dayTo = new Date(day).setHours(23, 59, 59, 999)}
    {@const dayReports = reports.filter(
      (it) => it.employee === person && it.date != null && dayFrom <= it.date && it.date <= dayTo
    )}
    <!-- {@const personIds = getPersonByPersonRef(person) -->
    {@const taskIds = new Set(dayReports.map((it) => it.attachedTo))}
    {@const dayIssues = Array.from(new Set([...Array.from(taskIds), ...(issuesDayMap.get(dayFrom) ?? [])]))
      .map((it) => issues.get(it))
      .filter(
        (it) =>
          it !== undefined &&
          (taskIds.has(it._id) ||
            (it.createdBy !== undefined &&
              authorRefs.get(it.createdBy) === person &&
              dayFrom === new Date(it.createdOn ?? 0).setHours(0, 0, 0, 0)) ||
            (it.modifiedBy !== undefined &&
              authorRefs.get(it.modifiedBy) === person &&
              dayFrom === new Date(it.modifiedOn ?? 0).setHours(0, 0, 0, 0)))
      )}
    {#if onlyReports}
      {@const dayTotal = dayReports.reduce((a, b) => a + b.value, 0)}
      <div class="dayCell flex-center" style:height="{height}rem">
        {#if dayTotal > 0}
          <Button
            kind={'link'}
            size={'x-small'}
            on:click={() => {
              showPopup(PersonReportsPopup, { person, ld: dayFrom, rd: dayTo })
            }}
          >
            <svelte:fragment slot="content">
              <TimePresenter value={dayTotal} />
            </svelte:fragment>
          </Button>
        {:else}
          <div class="dayCellAdd">
            <ButtonIcon
              icon={IconAdd}
              size={'extra-small'}
              kind={'tertiary'}
              on:click={() => {
                showPopup(PersonReportsPopup, { person, ld: dayFrom, rd: dayTo })
              }}
            />
          </div>
        {/if}
      </div>
    {:else}
      <div class="dayCell" style:overflow="auto" style:height="{height}rem" class:p-1={true}>
        {#if dayReports.length === 0 && dayIssues.length === 0}
          <div class="dayCellAdd dayCellAdd--center">
            <ButtonIcon
              icon={IconAdd}
              size={'extra-small'}
              kind={'tertiary'}
              on:click={() => {
                showPopup(PersonReportsPopup, { person, ld: dayFrom, rd: dayTo })
              }}
            />
          </div>
        {/if}
        <div class="flex flex-col p-1">
          {#each dayIssues as issue}
            {@const createdByMe = dayFrom === new Date(issue?.createdOn ?? 0).setHours(0, 0, 0, 0)}
            {@const closedByMe =
              dayFrom === new Date(issue?.modifiedOn ?? 0).setHours(0, 0, 0, 0) && issue?.isDone === true}
            {@const issueReports = dayReports.filter((it) => it.attachedTo === issue?._id)}
            <div class="flex flex-row-center gap-2 flex-wrap mb-1">
              <div class="flex flex-row-center gap-2">
                {#if createdByMe}
                  <Icon icon={IconCircleAdd} size={'small'} />
                {/if}
                {#if closedByMe || dayReports.length > 0}
                  <IssueStatusPresenter value={issue} />
                {/if}
                {#if createdByMe || closedByMe || dayReports.length > 0}
                  <IssuePresenter value={issue} />
                {/if}
              </div>
              {#if issueReports.length > 0}
                <Button
                  kind={'link'}
                  size={'x-small'}
                  on:click={() => {
                    showPopup(EstimationPopup, { object: issue })
                  }}
                >
                  <svelte:fragment slot="content">
                    <TimePresenter value={issueReports.reduce((a, b) => a + b.value, 0)} />
                  </svelte:fragment>
                </Button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </svelte:fragment>
</PersonCalendar>

<style lang="scss">
  .dayCell {
    position: relative;

    .dayCellAdd {
      opacity: 0;
      transition: opacity 0.1s ease-in-out;
      z-index: 1;

      &.dayCellAdd--center {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }
    }

    &:hover .dayCellAdd {
      opacity: 1;
    }
  }
</style>
