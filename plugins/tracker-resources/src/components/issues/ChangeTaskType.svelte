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
  import { type Ref, type Status } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import presentation, { createQuery, getClient } from '@hcengineering/presentation'
  import task, { type TaskType } from '@hcengineering/task'
  import { taskTypeStore, TaskTypeIcon } from '@hcengineering/task-resources'
  import { type Issue, type IssueStatus, type Project } from '@hcengineering/tracker'
  import ui, {
    type DropdownIntlItem,
    Icon,
    IconForward,
    IconInfo,
    Label,
    Modal,
    ModernDropdown,
    tooltip
  } from '@hcengineering/ui'
  import { getAttributePresenter, statusStore } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'

  import tracker from '../../plugin'
  import {
    buildTaskTypeChangePlan,
    changeIssueTaskType,
    getReportableLostAttributes,
    getTaskTypeChoices
  } from '../../taskTypeChange'
  import IssueStatusIcon from './IssueStatusIcon.svelte'
  import TaskTypePresenter from './TaskTypePresenter.svelte'

  export let value: Issue
  export let targetKind: Ref<TaskType> | undefined = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()

  let processing = false

  const projectQuery = createQuery()
  let project: Project | undefined
  $: projectQuery.query(tracker.class.Project, { _id: value.space }, (res) => {
    ;[project] = res
  })

  let kind: Ref<TaskType> | undefined = targetKind ?? value.kind
  $: preselected = targetKind !== undefined
  $: currentType = $taskTypeStore.get(value.kind)
  $: targetType = kind !== undefined ? $taskTypeStore.get(kind) : undefined

  const descriptors = client.getModel().findAllSync(task.class.TaskTypeDescriptor, {})
  $: choices = getTaskTypeChoices(hierarchy, $taskTypeStore, project?.type, descriptors)

  $: isChanged = targetType !== undefined && targetType._id !== value.kind

  $: plan = isChanged && targetType !== undefined ? buildTaskTypeChangePlan(hierarchy, value, targetType) : undefined
  $: lost = plan !== undefined ? getReportableLostAttributes(plan) : []

  let status: Ref<IssueStatus> | undefined = undefined

  // Seeded only on an exact reference match — matching by name or category would silently move the
  // issue between meaningfully different states. Keyed on the resolved type, not on `kind`: the
  // type store fills in asynchronously, so seeding on the ref alone would run once against an
  // unresolved type and never again.
  let statusSeededFor: TaskType | undefined
  $: if (targetType !== undefined && targetType !== statusSeededFor) {
    statusSeededFor = targetType
    status = targetType.statuses.includes(value.status) ? value.status : undefined
  }

  $: statuses =
    targetType !== undefined
      ? targetType.statuses.map((s) => $statusStore.byId.get(s)).filter((s) => s !== undefined)
      : []

  $: canSave = isChanged && status !== undefined

  $: statusItems = statuses.map(
    (st): DropdownIntlItem => ({
      id: st._id,
      label: getEmbeddedLabel(st.name),
      icon: IssueStatusIcon,
      iconProps: { value: st, size: 'small', taskType: kind }
    })
  )

  $: typeItems = choices.map(
    (it): DropdownIntlItem => ({
      id: it._id,
      label: getEmbeddedLabel(it.name),
      icon: TaskTypeIcon,
      iconProps: { value: it }
    })
  )

  async function changeType (): Promise<void> {
    if (targetType === undefined || !canSave) {
      return
    }
    processing = true
    try {
      await changeIssueTaskType(client, value, targetType, status as Ref<Status>)
    } finally {
      processing = false
    }
    dispatch('close')
  }
</script>

<Modal
  label={tracker.string.ChangeTaskType}
  type={'type-popup'}
  width={'small'}
  padding={'0 var(--spacing-3) var(--spacing-2)'}
  okLabel={presentation.string.Change}
  okAction={changeType}
  {canSave}
  okLoading={processing}
  onCancel={() => dispatch('close')}
  noTopIndent
  on:changeContent
>
  <div class="hulyModal-content__settingsSet" style:padding={'0'}>
    <div class="hulyModal-content__settingsSet-line no-top-border">
      <span class="label"><Label label={tracker.string.NewTaskType} /></span>
      {#if preselected}
        <div class="transition">
          <span class="transition__from"><TaskTypePresenter value={currentType} /></span>
          <span class="transition__arrow"><Icon icon={IconForward} size={'small'} /></span>
          <span class="transition__to"><TaskTypePresenter value={targetType} /></span>
        </div>
      {:else}
        <ModernDropdown
          items={typeItems}
          bind:selected={kind}
          autoSelect={false}
          size={'medium'}
          justify={'left'}
          width={'12rem'}
          showDropdownIcon
        />
      {/if}
    </div>

    <div class="hulyModal-content__settingsSet-line" style:border-bottom={'none'}>
      <span class="label"><Label label={tracker.string.SelectNewStatus} /></span>
      <ModernDropdown
        items={statusItems}
        bind:selected={status}
        placeholder={ui.string.NotSelected}
        autoSelect={false}
        size={'medium'}
        justify={'left'}
        width={'12rem'}
        showDropdownIcon
      />
    </div>

    {#if lost.length > 0}
      <div class="lost">
        <div class="lost__note">
          <Icon icon={IconInfo} size={'small'} />
          <span>
            <Label label={tracker.string.LostAttributesHint} params={{ name: targetType?.name ?? '' }} />
          </span>
        </div>
        <div class="lost__list">
          <!-- Keyed by owner too: the same attribute name can appear on the class and on a mixin. -->
          {#each lost as it (`${it.attribute.attributeOf}.${it.key}`)}
            <span class="labelOnPanel" use:tooltip={{ component: Label, props: { label: it.attribute.label } }}>
              <Label label={it.attribute.label} />
            </span>
            <div class="lost__value">
              <!-- Resolved against the attribute's own owner: a task type's attributes sit either on
                   its target class or on a mixin, and the issue's class only knows the former. -->
              {#await getAttributePresenter(client, it.attribute.attributeOf, it.key, { key: it.key })}
                <!-- resolving -->
              {:then model}
                <svelte:component this={model.presenter} value={it.value} {...model.props ?? {}} />
              {:catch}
                <!-- A type with no presenter registered: the field is still named above, which is
                     what the warning is really about. -->
              {/await}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .transition {
    display: flex;
    align-items: center;
    gap: var(--spacing-1);
    min-width: 0;
  }

  .transition__from {
    display: flex;
    min-width: 0;
    opacity: 0.6;
  }

  .transition__to {
    display: flex;
    min-width: 0;
    font-weight: 500;
  }

  .transition__arrow {
    display: flex;
    flex-shrink: 0;
    color: var(--theme-halfcontent-color);
  }

  .lost {
    margin-top: var(--spacing-2);
  }

  .lost__note {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-0_75);
    padding: var(--spacing-1) var(--spacing-1_5);
    color: var(--theme-warning-color);
    font-size: 0.75rem;
    line-height: 1.125rem;
    background-color: color-mix(in srgb, var(--theme-warning-color) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-warning-color) 30%, transparent);
    border-radius: var(--small-BorderRadius, 0.25rem);
  }

  .lost__note :global(svg) {
    flex-shrink: 0;
    margin-top: 0.0625rem;
  }

  .lost__list {
    display: grid;
    grid-template-columns: auto auto;
    grid-auto-rows: minmax(1.75rem, max-content);
    align-items: center;
    justify-content: start;
    row-gap: var(--spacing-0_5);
    column-gap: var(--spacing-1_5);
    margin-top: var(--spacing-1_5);
  }

  .labelOnPanel {
    overflow: hidden;
    max-width: 10rem;
    color: var(--theme-dark-color);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .lost__value {
    display: flex;
    min-width: 0;
    color: var(--theme-caption-color);
  }
</style>
