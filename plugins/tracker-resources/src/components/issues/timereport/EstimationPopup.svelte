<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
  import presentation, { Card, createQuery, getClient } from '@hcengineering/presentation'
  import { Issue, Project, reduceChildInfoTree } from '@hcengineering/tracker'
  import {
    Button,
    EditStyle,
    eventToHTMLElement,
    floorFractionDigits,
    IconAdd,
    Label,
    showPopup
  } from '@hcengineering/ui'
  import EditEstimationPopup from './EditEstimationPopup.svelte'
  import { createEventDispatcher } from 'svelte'
  import tracker from '../../../plugin'
  import IssuePresenter from '../IssuePresenter.svelte'
  import EstimationStatsPresenter from './EstimationStatsPresenter.svelte'
  import SubIssuesEstimations from './SubIssuesEstimations.svelte'
  import TimeSpendReportPopup from './TimeSpendReportPopup.svelte'
  import TimeSpendReports from './TimeSpendReports.svelte'
  import TimePresenter from './TimePresenter.svelte'
  import EstimationProgressCircle from './EstimationProgressCircle.svelte'

  export let format: 'text' | 'password' | 'number'
  export let kind: EditStyle = 'search-style'
  export let object: Issue

  $: _value = object.estimation

  const dispatch = createEventDispatcher()
  const client = getClient()

  $: childIds = Array.from((object.childInfo ?? []).map((it) => it.childId))

  const query = createQuery()

  let currentProject: Project | undefined

  $: query.query(
    object._class,
    { _id: object._id },
    (res) => {
      const r = res.shift()
      if (r !== undefined) {
        object = r
        currentProject = r.$lookup?.space
      }
    },
    {
      lookup: {
        space: tracker.class.Project
      }
    }
  )
  $: defaultTimeReportDay = currentProject?.defaultTimeReportDay

  $: childInfos = object.childInfo ?? []
  $: treeResult = reduceChildInfoTree(childInfos, 0, 0)
  $: childReportTime = floorFractionDigits(treeResult.totalReportedTime, 3)
  $: childEstimationTime = treeResult.totalEstimation
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<Card
  label={tracker.string.Estimation}
  canSave={true}
  okAction={() => {
    dispatch('close')
  }}
  okLabel={presentation.string.Ok}
  gap={'gapV-4'}
  on:close={() => {
    dispatch('close', null)
  }}
  on:changeContent
>
  <svelte:fragment slot="title">
    <div class="flex-row-center">
      <Label label={tracker.string.Estimation} />:
      <div
        class="ml-2 mr-4"
        on:click={(evt) => {
          showPopup(EditEstimationPopup, { value: object.estimation }, eventToHTMLElement(evt), (res) => {
            if (typeof res === 'number') {
              if (_value !== res) {
                _value = res
                void client.update(object, { estimation: res })
                object.estimation = res
              }
            }
          })
        }}
      >
        <EstimationStatsPresenter value={object} estimation={_value} />
      </div>
      <Label label={tracker.string.RemainingTime} />:
      <div class="ml-2 mr-4">
        <TimePresenter value={object.remainingTime} />
      </div>
    </div>
  </svelte:fragment>

  <svelte:fragment slot="header">
    <IssuePresenter value={object} disabled />
  </svelte:fragment>

  <div class="flex flex-row-center">
    {#if childInfos.length > 0}
      <div class="ml-1 mr-2"><Label label={tracker.string.SubIssues} />:</div>
      <div class="icon">
        <EstimationProgressCircle items={[{ value: childReportTime, max: childEstimationTime }]} />
      </div>
      <div class="ml-1 romColor">
        <TimePresenter value={childReportTime} />
      </div>
      <span>/</span>
      <div class="romColor">
        <TimePresenter value={childEstimationTime} />
      </div>
    {/if}
    {#if childInfos.length > 0}
      <div class="flex flex-row-center gap-2 ml-2">
        <Label label={tracker.string.RemainingTime} />:
        <TimePresenter value={Math.max(0, childEstimationTime - childReportTime)} />
      </div>
    {/if}
  </div>

  {#if currentProject}
    <TimeSpendReports
      issue={object}
      query={{ attachedTo: object._id }}
      childQuery={{ attachedTo: { $in: [object._id, ...childIds] } }}
    />
  {/if}

  {#if currentProject}
    <SubIssuesEstimations issue={object} />
  {/if}
  <svelte:fragment slot="buttons">
    <Button
      icon={IconAdd}
      size={'large'}
      on:click={() => {
        showPopup(
          TimeSpendReportPopup,
          {
            issue: object,
            issueId: object._id,
            issueClass: object._class,
            space: object.space,
            assignee: object.assignee,
            defaultTimeReportDay
          },
          'top'
        )
      }}
      label={tracker.string.TimeSpendReportAdd}
    />
  </svelte:fragment>
</Card>
