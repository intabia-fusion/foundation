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
  import core, { type Class, type Doc, type Ref } from '@hcengineering/core'
  import presentation, { getClient } from '@hcengineering/presentation'
  import ui, {
    Button,
    DropdownIntlItem,
    DropdownTextItem,
    IconClose,
    Label,
    ModernDropdown,
    ModernDropdownLabels
  } from '@hcengineering/ui'
  import type { CollectionOperation, WorkflowFieldValue, WorkflowTransformCall } from '@hcengineering/workflow'

  import plugin from '../../../../plugin'
  import TransformRow from './TransformRow.svelte'
  import { ContextOption, FieldRow } from './types'
  import ValueEditor from './ValueEditor.svelte'
  import { isCollectionAttribute } from './utils'

  export let _class: Ref<Class<Doc>>
  export let row: FieldRow
  export let canRemove: boolean = false
  export let dropdownItems: DropdownTextItem[] = []
  export let contextOptions: ContextOption[] = []

  const dispatch = createEventDispatcher<{
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    remove: void
    select: DropdownTextItem['id']
    value: WorkflowFieldValue
    operation: CollectionOperation
    context: MouseEvent
    transform: MouseEvent
    editTransform: { fn: WorkflowTransformCall, event: MouseEvent }
  }>()

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: selectedFieldId = row.attribute?._id
  $: isCollection = row.attribute != null && isCollectionAttribute(hierarchy, row.attribute)

  interface OperationDropdownItem extends DropdownIntlItem {
    id: CollectionOperation
  }

  const operationItems: OperationDropdownItem[] = [
    { id: 'set', label: plugin.string.Set },
    { id: 'add', label: presentation.string.Add },
    { id: 'remove', label: presentation.string.Remove }
  ]

  function onOperationSelected (detail: DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined): void {
    if (detail != null) {
      const val = Array.isArray(detail) ? detail[0] : detail
      if (val === 'set' || val === 'add' || val === 'remove') {
        dispatch('operation', val)
      }
    }
  }
</script>

<div class="update-field-row" class:collection={isCollection}>
  {#if isCollection}
    <div class="update-field-row__header">
      <div class="update-field-row__col">
        <span class="update-field-row__label"><Label label={plugin.string.Field} /></span>
        <div class="update-field-row__input-wrapper">
          <ModernDropdownLabels
            items={dropdownItems}
            selected={selectedFieldId}
            autoSelect={false}
            placeholder={ui.string.NotSelected}
            justify="left"
            size="large"
            width="100%"
            on:selected={(e) => {
              if (e.detail != null) {
                const val = Array.isArray(e.detail) ? e.detail[0] : e.detail
                if (val != null) {
                  dispatch('select', String(val))
                }
              }
            }}
          />
        </div>
      </div>

      <div class="update-field-row__col update-field-row__col--op">
        <span class="update-field-row__label"><Label label={plugin.string.Action} /></span>
        <div class="update-field-row__input-wrapper">
          <ModernDropdown
            items={operationItems}
            selected={row.operation ?? 'add'}
            autoSelect={true}
            size="large"
            width="100%"
            on:selected={(e) => {
              onOperationSelected(e.detail)
            }}
          />
        </div>
      </div>

      <div class="update-field-row__remove" class:hidden={!canRemove}>
        <Button
          icon={IconClose}
          kind="ghost"
          disabled={!canRemove}
          on:click={() => {
            if (canRemove) {
              dispatch('remove')
            }
          }}
        />
      </div>
    </div>

    <div class="update-field-row__body">
      <ValueEditor
        {_class}
        {row}
        {contextOptions}
        on:value={(e) => {
          dispatch('value', e.detail)
        }}
        on:context={(e) => {
          dispatch('context', e.detail)
        }}
      />
    </div>
  {:else}
    <div class="update-field-row__main">
      <div class="update-field-row__col">
        <span class="update-field-row__label"><Label label={plugin.string.Field} /></span>
        <div class="update-field-row__input-wrapper">
          <ModernDropdownLabels
            items={dropdownItems}
            selected={selectedFieldId}
            autoSelect={false}
            placeholder={ui.string.NotSelected}
            justify="left"
            size="large"
            width="100%"
            on:selected={(e) => {
              if (e.detail != null) {
                const val = Array.isArray(e.detail) ? e.detail[0] : e.detail
                if (val != null) {
                  dispatch('select', String(val))
                }
              }
            }}
          />
        </div>
      </div>

      <div class="update-field-row__divider">=</div>

      <ValueEditor
        {_class}
        {row}
        {contextOptions}
        on:value={(e) => {
          dispatch('value', e.detail)
        }}
        on:context={(e) => {
          dispatch('context', e.detail)
        }}
      />

      <div class="update-field-row__remove" class:hidden={!canRemove}>
        <Button
          icon={IconClose}
          kind="ghost"
          disabled={!canRemove}
          on:click={() => {
            if (canRemove) {
              dispatch('remove')
            }
          }}
        />
      </div>
    </div>

    <TransformRow
      {row}
      on:transform={(e) => {
        dispatch('transform', e.detail)
      }}
      on:editTransform={(e) => {
        dispatch('editTransform', e.detail)
      }}
      on:value={(e) => {
        dispatch('value', e.detail)
      }}
    />
  {/if}
</div>

<style lang="scss">
  .update-field-row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: var(--medium-BorderRadius);
    background-color: transparent;
    border: 1px solid var(--global-subtle-ui-BorderColor);

    &__header {
      display: grid;
      grid-template-columns: 1fr 1fr 2rem;
      align-items: flex-end;
      gap: 0.75rem;
      width: 100%;
    }

    &__body {
      display: flex;
      width: 100%;
    }

    &__main {
      display: grid;
      grid-template-columns: 1fr 1.5rem 1fr 2rem;
      align-items: flex-end;
      gap: 0.75rem;
      width: 100%;
    }

    &__col {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      width: 100%;
      min-width: 0;

      &--op {
        width: 100%;
        min-width: 130px;
      }
    }

    &__input-wrapper {
      width: 100%;
      display: flex;
      align-items: stretch;

      :global(.modern-dropdown-labels-container),
      :global(.modern-dropdown-container) {
        width: 100%;
      }

      :global(.hulyButton) {
        height: 2.25rem !important;
        min-height: 2.25rem !important;
        max-height: 2.25rem !important;
      }
    }

    &__label {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }

    &__divider {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--global-tertiary-TextColor);
      height: 2.25rem;
      width: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      user-select: none;
      box-sizing: border-box;
    }

    &__remove {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 2.25rem;
      width: 2rem;
      flex-shrink: 0;

      &.hidden {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
      }
    }
  }
</style>
