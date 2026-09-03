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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Ref, Status } from '@hcengineering/core'
  import presentation, { getClient } from '@hcengineering/presentation'
  import { StatePresenter } from '@hcengineering/task-resources'
  import ui, {
    DropdownIntlItem,
    IconError,
    Label,
    LabelAndProps,
    Modal,
    ModernDropdown,
    ModernEditbox
  } from '@hcengineering/ui'
  import {
    addTransition,
    ConflictInfo,
    getTransitionConflict,
    Workflow,
    WorkflowTransition
  } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import { getEmbeddedLabel } from '@hcengineering/platform'

  export let workflow: Workflow
  export let statuses: Status[] = []
  export let transitions: WorkflowTransition[] = []

  const client = getClient()

  const dispatch = createEventDispatcher<{ close: undefined }>()

  let name = ''

  let toStatusId: Ref<Status> | undefined = undefined
  $: toStatusItem = statuses.find((s) => s._id === toStatusId)
  $: to = toStatusId

  let fromStatusItemIds: string[] | undefined = ['null']

  $: fromStatusItems = [
    { label: plugin.string.AnyStatus, id: 'null', exclusive: true },
    ...statuses.map(
      (s): DropdownIntlItem => ({
        id: s._id,
        label: getEmbeddedLabel(s.name),
        icon: StatePresenter,
        iconProps: { value: s, shouldShowName: false }
      })
    )
  ]

  $: toStatusItems = statuses.map(
    (s): DropdownIntlItem => ({
      id: s._id,
      label: getEmbeddedLabel(s.name),
      icon: StatePresenter,
      iconProps: { value: s, shouldShowName: false }
    })
  )

  $: isSelf = to != null && fromStatusItemIds != null && fromStatusItemIds.includes(to)

  let conflictInfo: ConflictInfo | null = null
  $: {
    const fromVal =
      fromStatusItemIds !== undefined && fromStatusItemIds.includes('null')
        ? null
        : (fromStatusItemIds as Ref<Status>[])
    conflictInfo =
      to != null && fromStatusItemIds != null && fromStatusItemIds.length > 0
        ? getTransitionConflict({ from: fromVal, to }, transitions)
        : null
  }

  let isSaving = false
  async function save (): Promise<void> {
    if (
      to === undefined ||
      name.trim() === '' ||
      fromStatusItemIds == null ||
      fromStatusItemIds.length === 0 ||
      conflictInfo != null ||
      isSelf
    ) {
      return
    }
    try {
      isSaving = true
      const from = fromStatusItemIds.includes('null') ? null : (fromStatusItemIds as Ref<Status>[])
      await addTransition(client, workflow._id, name.trim(), from, to)
      dispatch('close')
    } finally {
      isSaving = false
    }
  }

  function getOkTooltip (name: string, toStatusItem: Status | undefined): LabelAndProps | undefined {
    if (name.trim().length === 0) {
      return {
        label: plugin.string.NameRequired
      }
    }
    if (toStatusItem == null) {
      return {
        label: plugin.string.StatusToRequired
      }
    }
    if (isSelf) {
      const st = statuses.find((s) => s._id === to)
      return {
        label: plugin.string.SelfTransitionError,
        props: {
          to: st?.name ?? ''
        }
      }
    }
    if (conflictInfo != null) {
      const toStatus = statuses.find((s) => s._id === to)
      const fromStatus = statuses.find((s) => s._id === conflictInfo?.status)
      return {
        label: plugin.string.TransitionConflictError,
        props: {
          to: toStatus?.name ?? '',
          from: fromStatus?.name ?? '',
          transition: conflictInfo.transition.name
        }
      }
    }

    return undefined
  }
</script>

<Modal
  type="type-popup"
  okAction={save}
  okLabel={presentation.string.Create}
  okLoading={isSaving}
  canSave={name.trim() !== '' &&
    to != null &&
    fromStatusItemIds != null &&
    fromStatusItemIds.length > 0 &&
    conflictInfo == null &&
    !isSelf}
  okTooltip={getOkTooltip(name, toStatusItem)}
  label={plugin.string.CreateTransition}
  width="medium"
  onCancel={() => dispatch('close')}
>
  <div class="hulyModal-content__titleGroup title-group">
    <ModernEditbox bind:value={name} label={plugin.string.Name} kind="transparent" autoFocus={true} width="100%" />
  </div>

  <div class="hulyModal-content__settingsSet settings-set">
    <div class="hulyModal-content__settingsSet-line">
      <span class="label"> <Label label={plugin.string.From} /></span>
      <ModernDropdown
        dataId="transition-from"
        items={fromStatusItems}
        bind:selected={fromStatusItemIds}
        multiselect={true}
        wrap={true}
        autoSelect={false}
        placeholder={ui.string.NotSelected}
        justify="left"
        width="25rem"
      />
    </div>

    <div class="hulyModal-content__settingsSet-line">
      <span class="label"> <Label label={plugin.string.To} /> </span>
      <ModernDropdown
        dataId="transition-to"
        items={toStatusItems}
        bind:selected={toStatusId}
        autoSelect={false}
        placeholder={ui.string.NotSelected}
        justify="left"
        width="25rem"
      />
    </div>

    {#if isSelf}
      {@const toStatus = statuses.find((s) => s._id === to)}
      <div class="error-row">
        <div class="error-icon">
          <IconError size="small" />
        </div>
        <span class="error-text">
          <Label
            label={plugin.string.SelfTransitionError}
            params={{
              to: toStatus?.name ?? ''
            }}
          />
        </span>
      </div>
    {:else if conflictInfo != null}
      {@const toStatus = statuses.find((s) => s._id === to)}
      {@const fromStatus = statuses.find((s) => s._id === conflictInfo?.status)}
      <div class="error-row">
        <div class="error-icon">
          <IconError size="small" />
        </div>
        <span class="error-text">
          <Label
            label={plugin.string.TransitionConflictError}
            params={{
              to: toStatus?.name ?? '',
              from: fromStatus?.name ?? '',
              transition: conflictInfo.transition.name
            }}
          />
        </span>
      </div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .title-group {
    padding: 0;
  }

  .settings-set {
    padding: 1rem 1rem 0 1rem;
  }

  .error-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--negative-button-default);
    font-size: 0.8125rem;
    line-height: 1.125rem;
    margin-top: 1.5rem;
    min-width: 0;
    word-break: break-word;
    overflow-wrap: anywhere;

    .error-icon {
      display: flex;
      align-items: center;
      margin-top: 0.0625rem;
      flex-shrink: 0;
    }

    .error-text {
      color: var(--negative-button-default);
      word-break: break-word;
      overflow-wrap: anywhere;
      min-width: 0;
    }
  }
</style>
