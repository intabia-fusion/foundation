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
  import core, { type Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import type { ProjectType, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import { Icon, IconError, Label } from '@hcengineering/ui'
  import type {
    AttributeResolutionConfig,
    ScreenResolutionConfig,
    WorkflowCompatibilityReport,
    WorkflowConfig
  } from '@hcengineering/workflow'

  import plugin from '../../../plugin'
  import { getAttributeUsageLocations, resolveAttributeItemIcon } from './utils'

  export let projectType: ProjectType | null = null
  export let selectedTaskTypeId: Ref<TaskType> | undefined = undefined
  export let report: WorkflowCompatibilityReport | null = null
  export let parsedConfig: WorkflowConfig | null = null
  export let screenResolutions: Record<string, ScreenResolutionConfig> = {}
  export let attributeResolutions: Record<string, AttributeResolutionConfig> = {}

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: targetTaskType = selectedTaskTypeId ? $taskTypeStore.get(selectedTaskTypeId) : undefined
  $: targetTaskTypeName = targetTaskType?.name ?? parsedConfig?.workflows?.[0]?.taskTypeName ?? ''

  $: attributesToCreate = (
    report?.attributes.filter((a) => !a.unresolvable && a.targetAttributeId === undefined) ?? []
  ).filter(
    (a) => getAttributeUsageLocations(a.fieldKey, a.sourceAttributeId, parsedConfig, screenResolutions).length > 0
  )

  $: unresolvableAttrs = (report?.attributes.filter((a) => a.unresolvable) ?? []).filter(
    (a) => getAttributeUsageLocations(a.fieldKey, a.sourceAttributeId, parsedConfig, screenResolutions).length > 0
  )

  $: hasSkippedAttributes = attributesToCreate.some((a) => attributeResolutions[a.fieldKey]?.action === 'skip')

  function setAttributeAction (fieldKey: string, action: 'create' | 'skip', label?: any): void {
    const current = attributeResolutions[fieldKey] ?? { action: 'create' }
    attributeResolutions[fieldKey] = {
      ...current,
      action,
      label: label ?? current.label
    }
    attributeResolutions = { ...attributeResolutions }
  }
</script>

<div class="form-section flex-col flex-gap-3">
  {#if hasSkippedAttributes}
    <div class="global-warning-banner flex-row-center flex-gap-2">
      <IconError size="small" />
      <span class="font-regular-12">
        <Label label={plugin.string.AttributesSkippedGlobalWarning} />
      </span>
    </div>
  {/if}

  <!-- Attributes to Create Section -->
  {#if attributesToCreate.length > 0}
    <div class="attributes-section flex-col flex-gap-2">
      <div class="section-header font-medium-14 mb-1">
        {#if targetTaskTypeName}
          <Label label={plugin.string.AttributesToCreateDescription} params={{ name: targetTaskTypeName }} />
        {:else}
          <Label label={plugin.string.AttributesToCreateDescriptionFallback} />
        {/if}
      </div>

      <div class="attributes-list flex-col flex-gap-2">
        {#each attributesToCreate as item (item.fieldKey)}
          {@const currentRes = attributeResolutions[item.fieldKey] ?? { action: 'create' }}
          {@const isSkipped = currentRes.action === 'skip'}
          {@const usages = getAttributeUsageLocations(
            item.fieldKey,
            item.sourceAttributeId,
            parsedConfig,
            screenResolutions
          )}
          {@const screenUsages = usages.filter((u) => u.type === 'screen')}
          {@const ruleUsages = usages.filter((u) => u.type === 'rule')}
          {@const iconInfo = resolveAttributeItemIcon(item, parsedConfig, hierarchy)}

          <div class="attribute-card" class:skipped={isSkipped}>
            <div class="attribute-card-header flex-between flex-row-center flex-gap-2">
              <div class="flex-row-center flex-gap-2 flex-grow min-w-0">
                <div class="attr-icon-box flex-center">
                  <Icon icon={iconInfo?.icon ?? core.icon.TypeString} iconProps={iconInfo?.iconProps} size="small" />
                </div>
                <div class="flex-col min-w-0">
                  <span class="attr-name font-medium-14">
                    <Label label={item.label ?? getEmbeddedLabel(item.fieldKey)} />
                  </span>
                </div>
              </div>

              <!-- Action Segmented Switch: Create vs Skip -->
              <div class="attr-action-segmented flex-row-center">
                <button
                  type="button"
                  class="action-btn"
                  class:selected={!isSkipped}
                  on:click={() => {
                    setAttributeAction(item.fieldKey, 'create', item.label)
                  }}
                >
                  <Label label={plugin.string.ActionCreate} />
                </button>
                <button
                  type="button"
                  class="action-btn"
                  class:selected={isSkipped}
                  on:click={() => {
                    setAttributeAction(item.fieldKey, 'skip', item.label)
                  }}
                >
                  <Label label={plugin.string.ActionSkip} />
                </button>
              </div>
            </div>

            <!-- Usage details -->
            {#if usages.length > 0}
              <div class="attribute-usages-area flex-col flex-gap-1 font-regular-12">
                {#if screenUsages.length > 0}
                  <div class="usage-row flex-row-center flex-gap-1-5 flex-wrap">
                    <span class="text-secondary"><Label label={plugin.string.UsedInScreens} /></span>
                    {#each screenUsages as sc}
                      <span class="usage-badge screen-badge">{sc.screenName}</span>
                    {/each}
                  </div>
                {/if}
                {#if ruleUsages.length > 0}
                  <div class="usage-row flex-row-center flex-gap-1-5 flex-wrap">
                    <span class="text-secondary"><Label label={plugin.string.UsedInRules} /></span>
                    {#each ruleUsages as r}
                      <span class="usage-badge rule-badge">
                        {r.transitionName}
                        {#if r.ruleTitle}(<Label label={r.ruleTitle} />){/if}
                      </span>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Unresolvable Attributes Section -->
  {#if unresolvableAttrs.length > 0}
    <div class="unresolvable-section flex-col flex-gap-2 mt-2">
      <div class="unresolvable-banner flex-row-center flex-gap-2">
        <IconError size="small" />
        <div class="flex-col">
          <span class="font-medium-14"><Label label={plugin.string.UnresolvableAttributesWarning} /></span>
          <span class="font-regular-12 mt-0-5 text-secondary">
            <Label label={plugin.string.UnresolvableAttributesDescription} />
          </span>
        </div>
      </div>

      <div class="unresolvable-list flex-col flex-gap-2">
        {#each unresolvableAttrs as item (item.fieldKey)}
          {@const usages = getAttributeUsageLocations(
            item.fieldKey,
            item.sourceAttributeId,
            parsedConfig,
            screenResolutions
          )}
          {@const screenUsages = usages.filter((u) => u.type === 'screen')}
          {@const ruleUsages = usages.filter((u) => u.type === 'rule')}
          {@const iconInfo = resolveAttributeItemIcon(item, parsedConfig, hierarchy)}

          <div class="unresolvable-card flex-col flex-gap-1-5">
            <div class="flex-between flex-row-center flex-gap-2">
              <div class="flex-row-center flex-gap-2">
                <div class="attr-icon-box flex-center">
                  <Icon icon={iconInfo?.icon ?? core.icon.TypeString} iconProps={iconInfo?.iconProps} size="small" />
                </div>
                <span class="font-medium-14">
                  <Label label={item.label ?? getEmbeddedLabel(item.fieldKey)} />
                </span>
              </div>
              {#if item.unresolvableReason}
                <span class="unresolvable-reason-badge font-regular-12">
                  <Label label={item.unresolvableReason} />
                </span>
              {/if}
            </div>

            {#if usages.length > 0}
              <div class="affected-impact-area flex-col flex-gap-1 font-regular-12">
                <span class="text-secondary font-medium-12">
                  <Label label={plugin.string.AffectedScreensAndRules} />
                </span>
                <ul class="affected-items-list font-regular-12">
                  {#each screenUsages as sc}
                    <li>{sc.screenName}</li>
                  {/each}
                  {#each ruleUsages as r}
                    <li>
                      {r.transitionName}
                      {#if r.ruleTitle}(<Label label={r.ruleTitle} />){/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style lang="scss">
  .form-section {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .global-warning-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-warning-highlight-BackgroundColor, rgba(227, 98, 9, 0.08));
    border: 1px solid var(--global-warning-BorderColor, rgba(227, 98, 9, 0.25));
    color: var(--global-warning-TextColor, #e36209);
    box-sizing: border-box;
    width: 100%;
  }

  .section-title {
    color: var(--theme-content-color, #1a1a1a);
  }

  .attributes-list,
  .unresolvable-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    width: 100%;
  }

  .attribute-card {
    padding: 1rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    background-color: var(--theme-card-bg, #ffffff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition:
      opacity 0.2s ease,
      border-color 0.2s ease;

    &.skipped {
      opacity: 0.75;
      border-color: rgba(227, 98, 9, 0.3);
      background-color: var(--theme-card-background, rgba(0, 0, 0, 0.01));
    }
  }

  .attr-icon-box {
    width: 2rem;
    height: 2rem;
    border-radius: 0.375rem;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.04));
    color: var(--theme-content-color, #1a1a1a);
    flex-shrink: 0;
  }

  .attr-name {
    color: var(--theme-content-color, #1a1a1a);
    font-weight: 500;
    font-size: 0.875rem;
  }

  .attr-action-segmented {
    display: inline-flex;
    align-items: center;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.05));
    border-radius: 0.5rem;
    padding: 3px;
    gap: 2px;
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.06));
    flex-shrink: 0;

    .action-btn {
      border: none;
      background: transparent;
      padding: 0.25rem 0.625rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--theme-secondary-color, #666);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(.selected) {
        color: var(--theme-content-color, #1a1a1a);
        background-color: rgba(0, 0, 0, 0.04);
      }

      &.selected {
        background-color: var(--theme-card-bg, #ffffff);
        color: var(--primary-color-purple-02, #6452db);
        font-weight: 600;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }
    }
  }

  .attribute-usages-area {
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.02));
  }

  .usage-row {
    gap: 0.375rem;
  }

  .usage-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 500;

    &.screen-badge {
      background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.08));
      border: 1px solid rgba(76, 56, 189, 0.15);
      color: var(--primary-color-purple-02, #6452db);
    }

    &.rule-badge {
      background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.04));
      border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
      color: var(--theme-content-color, #333);
    }
  }

  .unresolvable-banner {
    display: flex;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-warning-highlight-BackgroundColor, rgba(227, 98, 9, 0.08));
    border: 1px solid var(--global-warning-BorderColor, rgba(227, 98, 9, 0.25));
    color: var(--global-warning-TextColor, #e36209);
    box-sizing: border-box;
    width: 100%;
  }

  .unresolvable-card {
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background-color: var(--theme-card-background, rgba(0, 0, 0, 0.02));
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
  }

  .unresolvable-reason-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    background-color: rgba(218, 54, 51, 0.1);
    color: #da3633;
    font-weight: 500;
  }

  .affected-impact-area {
    margin-top: 0.25rem;
    padding-top: 0.375rem;
    border-top: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.06));
  }
</style>
