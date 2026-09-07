<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2023 Hardcore Engineering Inc.
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
  import type { IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { Issue, Project, reduceChildInfoTree } from '@hcengineering/tracker'
  import { ActionIcon, IconAdd, Label, eventToHTMLElement, floorFractionDigits, showPopup } from '@hcengineering/ui'

  import { activeProjects } from '../../../utils'
  import ReportsPopup from './ReportsPopup.svelte'
  import TimePresenter from './TimePresenter.svelte'
  import TimeSpendReportPopup from './TimeSpendReportPopup.svelte'
  import {
    DraftTimeReportPayload,
    ITimeReportService,
    DirectTimeReportService,
    DraftTimeReportService
  } from './service'

  // export let label: IntlString
  export let placeholder: IntlString
  export let object: Issue
  export let value: number
  export let kind: 'no-border' | 'link' = 'no-border'
  export let size: 'small' | 'medium' | 'large' = 'large'
  export let currentProject: Project | undefined = undefined
  export let readonly: boolean = false
  export let draft: boolean = false
  export let onChange: ((val: any) => void) | undefined = undefined
  export let showChildIssues: boolean = true

  $: if (currentProject === undefined) {
    currentProject = $activeProjects.get(object.space)
  }

  $: defaultTimeReportDay = currentProject?.defaultTimeReportDay

  const client = getClient()

  let service: ITimeReportService

  $: {
    if (service === undefined || service.isDraft !== draft) {
      if (draft) {
        const initialVal = typeof value === 'number' ? value : ((value as DraftTimeReportPayload)?.reportedTime ?? 0)
        service = new DraftTimeReportService((val) => {
          value = val.reportedTime
          onChange?.(val)
        }, initialVal)
      } else {
        service = new DirectTimeReportService(client)
      }
    }
  }

  function addTimeReport (event: MouseEvent): void {
    if (readonly) return
    showPopup(
      TimeSpendReportPopup,
      {
        issue: object,
        issueId: object._id,
        defaultTimeReportDay,
        issueClass: object._class,
        space: object.space,
        assignee: object.assignee,
        currentProject,
        service
      },
      eventToHTMLElement(event)
    )
  }
  function showReports (event: MouseEvent): void {
    if (readonly) return
    showPopup(ReportsPopup, { issue: object, service }, eventToHTMLElement(event))
  }
  $: childInfos = object.childInfo ?? []
  $: treeInfo = reduceChildInfoTree(childInfos, 0, 0)
  $: childTime = floorFractionDigits(treeInfo.totalReportedTime, 3)

  $: numericValue =
    typeof value === 'number'
      ? value
      : ((typeof value === 'object' && value !== null ? (value as DraftTimeReportPayload)?.reportedTime : undefined) ??
        object?.reportedTime ??
        0)
</script>

{#if kind === 'link'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    id="ReportedTimeEditor"
    class="link-container antiButton link {size} flex-grow flex-between"
    class:readonly
    on:click={showReports}
  >
    {#if numericValue !== undefined}
      <span class="flex-row-center">
        {#if showChildIssues}
          <TimePresenter value={numericValue + childTime} />
          {#if numericValue !== numericValue + childTime}
            <span class="ml-1">
              (<TimePresenter value={numericValue} />
              {#if childTime !== 0}
                / <TimePresenter value={childTime} />)
              {/if}
            </span>
          {/if}
        {:else}
          <TimePresenter value={numericValue} />
        {/if}
      </span>
    {:else}
      <span class="content-dark-color"><Label label={placeholder} /></span>
    {/if}
    {#if !readonly}
      <div class="add-action">
        <ActionIcon icon={IconAdd} size={'small'} action={addTimeReport} />
      </div>
    {/if}
  </div>
{:else if numericValue !== undefined}
  <span class="flex-row-center">
    <TimePresenter value={numericValue} />
    {#if childTime !== 0}
      / <TimePresenter value={childTime} />
    {/if}
  </span>
{:else}
  <span class="content-dark-color"><Label label={placeholder} /></span>
{/if}

<style lang="scss">
  .link-container {
    padding: 0px 0.75rem;
    border-radius: 0.375rem;

    &:not(.readonly) {
      cursor: pointer;

      .add-action {
        visibility: hidden;
      }

      &:hover {
        .add-action {
          visibility: visible;
        }
      }
    }
  }
</style>
