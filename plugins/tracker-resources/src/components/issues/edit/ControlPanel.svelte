<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { EmployeeBox, getPersonRefByPersonIdCb } from '@hcengineering/contact-resources'
  import core, { Class, Doc, Mixin, Ref } from '@hcengineering/core'
  import { AttributeBarEditor, getClient, KeyedAttribute } from '@hcengineering/presentation'
  import { Person } from '@hcengineering/contact'
  import tags from '@hcengineering/tags'
  import { Issue, reduceChildInfoTree } from '@hcengineering/tracker'
  import { Component, Label, floorFractionDigits } from '@hcengineering/ui'
  import { getDocMixins, getFiltredKeys, isCollectionAttr, ObjectBox } from '@hcengineering/view-resources'

  import tracker from '../../../plugin'
  import ComponentEditor from '../../components/ComponentEditor.svelte'
  import MilestoneEditor from '../../milestones/MilestoneEditor.svelte'
  import AssigneeEditor from '../AssigneeEditor.svelte'
  import DueDateEditor from '../DueDateEditor.svelte'
  import PriorityEditor from '../PriorityEditor.svelte'
  import StatusEditor from '../StatusEditor.svelte'
  import EstimationValueEditor from '../timereport/EstimationValueEditor.svelte'
  import ReportedTimeEditor from '../timereport/ReportedTimeEditor.svelte'
  import TimePresenter from '../timereport/TimePresenter.svelte'

  export let issue: Issue
  export let showAllMixins: boolean = false
  export let readonly = false

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const ignoreKeys = [
    'title',
    'description',
    'priority',
    'status',
    'number',
    'assignee',
    'component',
    'dueDate',
    'milestone',
    'relations',
    'blockedBy',
    'identifier',
    'estimation',
    'reportedTime',
    'remainingTime'
  ]

  const allowedCollections = ['collaborators']

  let keys: KeyedAttribute[] = []
  let collectionKeys: KeyedAttribute[] = []

  function updateKeys (_class: Ref<Class<Issue>>, ignoreKeys: string[]): void {
    const filtredKeys = getFiltredKeys(hierarchy, _class, ignoreKeys)
    keys = filtredKeys.filter((key) => !isCollectionAttr(hierarchy, key))
    collectionKeys = filtredKeys.filter(
      (key) => isCollectionAttr(hierarchy, key) && allowedCollections.includes(key.key)
    )
  }

  $: mixins = getDocMixins(issue, showAllMixins)

  function getMixinKeys (mixin: Ref<Mixin<Doc>>): KeyedAttribute[] {
    const mixinClass = hierarchy.getClass(mixin)
    const filtredKeys = getFiltredKeys(
      hierarchy,
      mixin,
      ignoreKeys,
      hierarchy.isMixin(mixinClass.extends as Ref<Class<Doc>>) ? mixinClass.extends : issue._class
    )
    return filtredKeys.filter((key) => !isCollectionAttr(hierarchy, key) || allowedCollections.includes(key.key))
  }

  $: updateKeys(issue._class, ignoreKeys)
  let creatorPersonRef: Ref<Person> | undefined
  $: if (issue.createdBy !== undefined) {
    getPersonRefByPersonIdCb(issue.createdBy, (ref) => {
      creatorPersonRef = ref ?? undefined
    })
  } else {
    creatorPersonRef = undefined
  }

  $: childInfos = issue.childInfo ?? []
  $: treeInfo = reduceChildInfoTree(childInfos, 0, 0)
  $: hasSubtasks = (issue.subIssues ?? 0) > 0
  $: estimationTotal = floorFractionDigits((issue.estimation ?? 0) + (treeInfo?.totalEstimation ?? 0), 3)
  $: reportedTotal = floorFractionDigits((issue.reportedTime ?? 0) + (treeInfo?.totalReportedTime ?? 0), 3)
  $: remainingTotal = floorFractionDigits(estimationTotal - reportedTotal, 3)

  function updateEstimation (val: number | undefined): void {
    if (val === undefined) return
    void client.update(issue, { estimation: val })
  }
</script>

<div class="popupPanel-body__aside-grid">
  {#if issue.template?.template}
    <span class="labelOnPanel">
      <Label label={tracker.string.IssueTemplate} />
    </span>
    <ObjectBox
      _class={tracker.class.IssueTemplate}
      value={issue.template?.template}
      size={'small'}
      kind={'link'}
      width={'100%'}
      label={tracker.string.NoIssueTemplate}
      icon={tracker.icon.Issues}
      searchField={'title'}
      allowDeselect={true}
      showNavigate={false}
      readonly
      docProps={{ disabled: true }}
    />
  {/if}

  <span class="labelOnPanel">
    <Label label={tracker.string.Status} />
  </span>

  <StatusEditor value={issue} size={'medium'} iconSize={'small'} shouldShowLabel isEditable={!readonly} />

  <span class="labelOnPanel">
    <Label label={tracker.string.Priority} />
  </span>
  <PriorityEditor value={issue} size={'medium'} shouldShowLabel isEditable={!readonly} width={'100%'} />

  <span class="labelOnPanel">
    <Label label={core.string.CreatedBy} />
  </span>
  <EmployeeBox
    value={creatorPersonRef}
    label={core.string.CreatedBy}
    kind={'link'}
    size={'medium'}
    avatarSize={'card'}
    width={'100%'}
    showNavigate={false}
    readonly
  />

  <span class="labelOnPanel">
    <Label label={tracker.string.Assignee} />
  </span>
  <AssigneeEditor object={issue} size={'medium'} avatarSize={'card'} width="100%" {readonly} />

  <span class="labelTop">
    <Label label={tracker.string.Labels} />
  </span>
  <Component
    is={tags.component.TagsAttributeEditor}
    props={{ object: issue, label: tracker.string.AddLabel, readonly }}
  />

  <div class="divider" />

  <span class="labelOnPanel">
    <Label label={tracker.string.Component} />
  </span>
  <ComponentEditor value={issue} space={issue.space} size={'medium'} isEditable={!readonly} />

  <span class="labelOnPanel">
    <Label label={tracker.string.Milestone} />
  </span>
  <MilestoneEditor value={issue} space={issue.space} size={'medium'} isEditable={!readonly} />

  {#if issue.dueDate != null}
    <div class="divider" />

    <span class="labelOnPanel">
      <Label label={tracker.string.DueDate} />
    </span>
    <DueDateEditor value={issue} width={'100%'} editable={!readonly} />
  {/if}

  {#if hasSubtasks}
    <div class="divider" />
    <span class="labelOnPanel"><Label label={tracker.string.EstimationTask} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <EstimationValueEditor
        placeholder={tracker.string.EstimationTask}
        value={issue.estimation}
        object={issue}
        onChange={updateEstimation}
        kind={'link'}
        {readonly}
      />
    </div>

    <span class="labelOnPanel"><Label label={tracker.string.EstimationSubtask} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <TimePresenter value={treeInfo.totalEstimation} />
    </div>

    <span class="labelOnPanel"><Label label={tracker.string.EstimationTotalTime} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <TimePresenter value={estimationTotal} />
    </div>

    <div class="divider" />

    <span class="labelOnPanel"><Label label={tracker.string.ReportedTaskTime} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <ReportedTimeEditor
        placeholder={tracker.string.ReportedTime}
        object={issue}
        value={issue.reportedTime}
        showChildIssues={false}
        kind={'link'}
        {readonly}
      />
    </div>

    <span class="labelOnPanel"><Label label={tracker.string.ReportedSubtaskTime} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <TimePresenter value={floorFractionDigits(treeInfo.totalReportedTime, 3)} />
    </div>

    <span class="labelOnPanel"><Label label={tracker.string.ReportedTotalTime} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <TimePresenter value={reportedTotal} />
    </div>
  {:else}
    <div class="divider" />
    <span class="labelOnPanel"><Label label={tracker.string.Estimation} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <EstimationValueEditor
        placeholder={tracker.string.Estimation}
        value={issue.estimation}
        object={issue}
        onChange={updateEstimation}
        kind={'link'}
        {readonly}
      />
    </div>

    <span class="labelOnPanel"><Label label={tracker.string.ReportedTime} /></span>
    <div class="flex flex-grow min-w-0 time-value">
      <ReportedTimeEditor
        placeholder={tracker.string.ReportedTime}
        object={issue}
        value={issue.reportedTime}
        kind={'link'}
        {readonly}
      />
    </div>
  {/if}

  <div class="divider" />
  <span class="labelOnPanel"><Label label={tracker.string.RemainingTime} /></span>
  <div class="flex flex-grow min-w-0 time-value">
    <TimePresenter value={hasSubtasks ? remainingTotal : issue.remainingTime} />
  </div>

  {#if keys.length > 0}
    <div class="divider" />
    {#each keys as key (typeof key === 'string' ? key : key.key)}
      <AttributeBarEditor
        {readonly}
        {key}
        identifier={issue.identifier}
        _class={issue._class}
        object={issue}
        showHeader={true}
        size={'medium'}
      />
    {/each}
  {/if}

  {#if collectionKeys.length > 0}
    <div class="divider" />
    {#each collectionKeys as key (typeof key === 'string' ? key : key.key)}
      <AttributeBarEditor
        {readonly}
        {key}
        identifier={issue.identifier}
        _class={issue._class}
        object={issue}
        showHeader={true}
        size={'medium'}
      />
    {/each}
  {/if}

  {#each mixins as mixin}
    {@const mixinKeys = getMixinKeys(mixin._id)}
    {#if mixinKeys.length}
      <div class="divider" />
      {#each mixinKeys as key (typeof key === 'string' ? key : key.key)}
        <AttributeBarEditor
          {key}
          identifier={issue.identifier}
          _class={mixin._id}
          {readonly}
          object={hierarchy.as(issue, mixin._id)}
          showHeader={true}
          size={'medium'}
        />
      {/each}
    {/if}
  {/each}
</div>

<style lang="scss">
  .time-value {
    padding: 0 0.75rem;

    :global(.link-container) {
      padding: 0;
    }
  }
</style>
