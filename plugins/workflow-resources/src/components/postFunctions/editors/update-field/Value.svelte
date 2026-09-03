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
  import { Button, IconClose, Label, tooltip } from '@hcengineering/ui'
  import { WorkflowFieldValue } from '@hcengineering/workflow'
  import { Class, Doc, Mixin, Ref } from '@hcengineering/core'
  import { getEmbeddedLabel, IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'

  import plugin from '../../../../plugin'

  export let _class: Ref<Class<Doc>>
  export let parsed: WorkflowFieldValue

  const dispatch = createEventDispatcher<{
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    clear: void
  }>()

  function getRowFieldKey (p: WorkflowFieldValue): string | undefined {
    switch (p.type) {
      case 'this':
      case 'parent':
        return p.fieldKey
      case 'preset':
      case 'const':
      default:
        return undefined
    }
  }

  function getRowFieldMixin (p: WorkflowFieldValue): Ref<Mixin<Doc>> | undefined {
    switch (p.type) {
      case 'this':
      case 'parent':
        return p.mixin
      case 'preset':
      case 'const':
      default:
        return undefined
    }
  }

  function getLabel (value: WorkflowFieldValue): IntlString {
    const fieldKey = getRowFieldKey(value)
    if (fieldKey == null || fieldKey === '') return getEmbeddedLabel(value.type)
    const mixin = getRowFieldMixin(value)

    const client = getClient()
    const hierarchy = client.getHierarchy()
    const attr = hierarchy.findAttribute(mixin ?? _class, fieldKey)
    if (attr == null) return getEmbeddedLabel(fieldKey)

    return attr.label
  }

  function getFullLabel (p: WorkflowFieldValue): IntlString {
    if (p.type === 'preset') {
      if (p.preset === '$currentUser') return plugin.string.CurrentUser
      if (p.preset === '$now') return plugin.string.Now
      return getEmbeddedLabel(p.preset)
    }
    const label = getLabel(p)
    return label
  }
</script>

<div
  class="value-pill"
  class:preset={parsed.type === 'preset'}
  class:this={parsed.type === 'this'}
  class:parent={parsed.type === 'parent'}
  use:tooltip={{ label: getFullLabel(parsed) }}
>
  {#if parsed.type === 'preset'}
    <span class="pill-label">
      {#if parsed.preset === '$currentUser'}
        <Label label={plugin.string.CurrentUser} />
      {:else if parsed.preset === '$now'}
        <Label label={plugin.string.Now} />
      {:else}
        {parsed.preset}
      {/if}
    </span>
  {:else if parsed.type === 'this'}
    <span class="pill-label"><Label label={getLabel(parsed)} /></span>
  {:else if parsed.type === 'parent'}
    <span class="pill-tag"><Label label={plugin.string.Parent} /></span>
    <span class="pill-label"><Label label={getLabel(parsed)} /></span>
  {/if}

  <Button
    icon={IconClose}
    kind="ghost"
    size="inline"
    on:click={() => {
      dispatch('clear')
    }}
  />
</div>

<style lang="scss">
  .value-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    margin-left: 0.25rem;
    border-radius: 0.375rem;
    background-color: var(--global-surface-02-BackgroundColor);
    border: 1px solid var(--theme-refinput-border, var(--global-subtle-ui-BorderColor));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    font-size: 0.8125rem;
    max-width: 100%;
    min-width: 0;

    .pill-tag {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
      color: var(--primary-color-purple-02, #6452db);
      flex-shrink: 0;
    }

    .pill-label {
      font-weight: 500;
      color: var(--global-primary-TextColor);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    &.parent {
      .pill-tag {
        background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
        color: var(--primary-color-purple-02, #6452db);
      }
    }
  }
</style>
