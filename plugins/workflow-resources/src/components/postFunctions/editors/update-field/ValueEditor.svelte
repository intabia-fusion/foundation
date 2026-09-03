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
  import { type Class, type Doc, type Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { Button, IconAdd, Label, ModernEditbox } from '@hcengineering/ui'
  import type { WorkflowFieldValue } from '@hcengineering/workflow'

  import plugin from '../../../../plugin'
  import { ContextOption, FieldRow } from './types'
  import { ensureFieldValue, isCollectionAttribute } from './utils'
  import Value from './Value.svelte'

  export let _class: Ref<Class<Doc>>
  export let row: FieldRow
  export let contextOptions: ContextOption[] = []

  const dispatch = createEventDispatcher<{
    value: WorkflowFieldValue
    context: MouseEvent
  }>()

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: isCollection = row.attribute != null && isCollectionAttribute(hierarchy, row.attribute)

  function handleEditorChange (val: WorkflowFieldValue | any): void {
    dispatch('value', ensureFieldValue(val))
  }

  let textValue: string = ''
  $: {
    const raw = row.value.type === 'const' ? row.value.value : ''
    textValue = Array.isArray(raw) ? raw.join(', ') : raw != null ? String(raw) : ''
  }

  function onTextInput (val: string): void {
    textValue = val
    if (isCollection) {
      const items = val
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
      handleEditorChange({ type: 'const', value: items })
    } else {
      handleEditorChange({ type: 'const', value: val })
    }
  }
</script>

<div class="update-field-value-editor__col">
  <span class="update-field-value-editor__label"><Label label={plugin.string.Value} /></span>
  <div class="update-field-value-editor__box" class:disabled={row.fieldKey === ''}>
    {#if row.value.type === 'preset' || row.value.type === 'this' || row.value.type === 'parent'}
      <div class="editor-content">
        <Value
          parsed={row.value}
          {_class}
          on:clear={() => {
            dispatch('value', { type: 'const', value: isCollection ? [] : '' })
          }}
        />
      </div>
    {:else if row.editor}
      <div class="editor-content">
        <svelte:component
          this={row.editor}
          label={plugin.string.Value}
          kind="ghost"
          size="large"
          width="100%"
          justify="left"
          disabled={row.fieldKey === ''}
          type={row.attribute?.type}
          value={row.value.type === 'const' ? row.value.value : row.value}
          object={{ space: '', _class: row.mixin ?? row.attribute?.attributeOf ?? _class }}
          attr={row.attribute}
          attribute={row.attribute}
          targetClass={row.mixin ?? row.attribute?.attributeOf ?? _class}
          draft={true}
          placeholder={plugin.string.Value}
          showNavigate={false}
          onChange={handleEditorChange}
        />
      </div>
    {:else if row.value.type === 'const'}
      <div class="editor-content">
        <ModernEditbox
          bind:value={textValue}
          label={plugin.string.Value}
          kind="ghost"
          width="100%"
          disabled={row.fieldKey === ''}
          on:input={() => {
            onTextInput(textValue)
          }}
          on:change={() => {
            onTextInput(textValue)
          }}
        />
      </div>
    {/if}

    {#if contextOptions.length > 0}
      <div class="box-actions">
        <Button
          icon={IconAdd}
          kind="ghost"
          disabled={row.fieldKey === ''}
          on:click={(e) => {
            if (row.fieldKey !== '') {
              dispatch('context', e)
            }
          }}
        />
      </div>
    {/if}
  </div>
</div>

<style lang="scss">
  .update-field-value-editor {
    &__col {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      width: 100%;
      min-width: 0;
    }

    &__label {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }

    &__box {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      height: auto;
      min-height: 2.25rem;
      border: 1px solid var(--theme-refinput-border, var(--global-subtle-ui-BorderColor));
      border-radius: var(--medium-BorderRadius, 0.375rem);
      background-color: var(--theme-refinput-bg, var(--theme-control-bg, transparent));
      width: 100%;
      box-sizing: border-box;
      padding-right: 0.25rem;
      gap: 0.25rem;
      cursor: pointer;

      &.disabled {
        opacity: 0.45;
        pointer-events: none;
        cursor: default;
        background-color: var(--theme-button-disabled, var(--theme-checkbox-disabled, rgba(0, 0, 0, 0.04)));
      }

      &:focus-within {
        border-color: var(--global-focus-BorderColor);
      }

      .editor-content {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.375rem;

        :global(.value-pill) {
          width: auto !important;
          max-width: 100%;
        }

        :global(button.button-container),
        :global(.huly-button),
        :global(.button-base),
        :global(.antiButton.link),
        :global(.link-button) {
          width: 100% !important;
          justify-content: flex-start !important;
          border: none !important;
        }

        :global(.step-container) {
          margin: 0 !important;
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
        }

        :global(.flex-row-center) {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.375rem;
          width: 100%;

          :global(.step-container:has(.tag-button)),
          :global(.step-container:last-child) {
            flex: 1;
            min-width: 4rem;
            display: flex;
          }

          :global(.step-container:first-child) {
            padding-left: 0.5rem;
          }
        }

        :global(.listitems-container) {
          margin: 0 !important;
          height: 1.75rem;
        }

        :global(.tag-button) {
          width: 100% !important;
          justify-content: flex-start !important;
          padding: 0 0.5rem 0 0.375rem !important;
          margin: 0 !important;
          border-radius: 0.375rem !important;
          height: 2.25rem !important;
          border: none;
          padding-left: 0.75rem !important;
          color: var(--theme-dark-color);
          &:hover {
            background: var(--theme-bg-color);
            color: var(--theme-content-color);
          }
        }

        :global(.tag-button .label) {
          font-size: 0.8125rem;
        }
      }

      .box-actions {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }
    }
  }
</style>
