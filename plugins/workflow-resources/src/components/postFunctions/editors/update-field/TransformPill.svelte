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
  import { Button, IconClose, Label, languageStore, tooltip } from '@hcengineering/ui'
  import type { WorkflowTransformCall, WorkflowValueFunction } from '@hcengineering/workflow'
  import { getClient } from '@hcengineering/presentation'
  import { getEmbeddedLabel, getResource, IntlString, translate } from '@hcengineering/platform'

  import plugin from '../../../../plugin'

  export let fn: WorkflowTransformCall
  export let index: number

  const dispatch = createEventDispatcher<{
    edit: MouseEvent
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    remove: void
  }>()

  let hint: IntlString | undefined
  let tooltipLabel: IntlString | undefined
  $: void getFunctionParamsHint(fn).then((res) => {
    hint = res
  })
  $: void getTransformTooltip(fn, $languageStore, hint).then((res) => {
    tooltipLabel = res
  })

  function getFunctionLabel (fn: WorkflowTransformCall): IntlString {
    const funcRef = fn?.func
    if (funcRef == null) return plugin.string.Function
    const client = getClient()
    const doc = client.getModel().getObject(funcRef)
    return doc?.label ?? getEmbeddedLabel(funcRef.toString())
  }

  function hasEditor (fn: WorkflowTransformCall): boolean {
    const funcRef = fn?.func
    if (funcRef == null) return false
    const client = getClient()
    const doc = client.getModel().getObject(funcRef)
    return (doc as any)?.editor != null
  }

  async function getFunctionParamsHint (fn: WorkflowTransformCall): Promise<IntlString | undefined> {
    if (fn?.func != null) {
      const doc = getClient().getModel().getObject<WorkflowValueFunction>(fn.func)
      if (doc?.propsLabelPresenter != null) {
        const labelFn = await getResource(doc.propsLabelPresenter)
        return labelFn(fn.props ?? {})
      }
    }
    return undefined
  }

  async function getTransformTooltip (fn: WorkflowTransformCall, lang: string, hint?: IntlString): Promise<IntlString> {
    const labelIntl = getFunctionLabel(fn)
    if (hint != null) {
      const hintStr = await translate(hint, {}, lang)
      const labelStr = await translate(labelIntl, {}, lang)
      return getEmbeddedLabel(`${labelStr}: ${hintStr}`)
    }
    return labelIntl
  }

  function handlePillClick (e: MouseEvent): void {
    if (hasEditor(fn)) {
      dispatch('edit', e)
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div
  class="transform-pill"
  class:editable={hasEditor(fn)}
  class:read-only={!hasEditor(fn)}
  use:tooltip={tooltipLabel != null ? { label: tooltipLabel } : undefined}
  on:click={handlePillClick}
>
  <span class="pill-step-num">{index + 1}.</span>
  <span class="pill-label"><Label label={getFunctionLabel(fn)} /></span>
  {#if hint}
    <span class="pill-params"><Label label={hint} /></span>
  {/if}
  <Button
    icon={IconClose}
    kind="ghost"
    size="inline"
    on:click={(e) => {
      e.stopPropagation()
      dispatch('remove')
    }}
  />
</div>

<style lang="scss">
  .transform-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.375rem;
    background-color: var(--global-surface-02-BackgroundColor);
    border: 1px solid var(--global-subtle-ui-BorderColor);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--global-primary-TextColor);
    transition: all 0.15s ease;
    max-width: 100%;
    min-width: 0;

    .pill-step-num {
      font-size: 0.6875rem;
      font-weight: 700;
      color: var(--global-tertiary-TextColor);
      margin-right: 0.125rem;
      flex-shrink: 0;
    }

    &.editable {
      cursor: pointer;
      border-color: var(--theme-refinput-border, var(--global-subtle-ui-BorderColor));

      &:hover {
        border-color: var(--global-focus-BorderColor);
        color: var(--primary-color-purple-02, #6452db);
      }
    }

    &.read-only {
      cursor: default;
      opacity: 0.9;
    }

    .pill-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 1;
    }

    .pill-params {
      font-size: 0.6875rem;
      font-weight: 600;
      color: var(--global-secondary-TextColor);
      background-color: rgba(0, 0, 0, 0.05);
      padding: 0.0625rem 0.25rem;
      border-radius: 0.25rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      min-width: 0;
      flex-shrink: 1;
    }
  }
</style>
