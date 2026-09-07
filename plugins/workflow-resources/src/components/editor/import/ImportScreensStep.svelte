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
  import type { Class, Ref } from '@hcengineering/core'
  import { getEmbeddedLabel, translate, type IntlString } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import type { ProjectType, TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import tracker from '@hcengineering/tracker'
  import { Icon, IconError, Label, ModernDropdown, languageStore, tooltip } from '@hcengineering/ui'
  import workflow, {
    type Screen,
    type ScreenConfig,
    type ScreenResolutionConfig,
    type WorkflowCompatibilityReport,
    type WorkflowConfig
  } from '@hcengineering/workflow'

  import plugin from '../../../plugin'
  import { getFieldIntlLabel, getTransitionsUsingScreen } from './utils'

  export let projectType: ProjectType
  export let selectedTaskTypeId: Ref<TaskType> | undefined = undefined
  export let parsedConfig: WorkflowConfig | null = null
  export let screenResolutions: Record<string, ScreenResolutionConfig> = {}
  export let report: WorkflowCompatibilityReport | null = null

  const client = getClient()
  const hierarchy = client.getHierarchy()

  let anyStatusLabel = ''
  $: void translate(plugin.string.AnyStatus, {}, $languageStore).then((l) => {
    anyStatusLabel = l
  })

  let allExistingScreens: Screen[] = []
  const screensQuery = createQuery()
  $: screensQuery.query(workflow.class.Screen, { projectType: projectType._id }, (res) => {
    allExistingScreens = res
  })

  $: targetTaskType = selectedTaskTypeId !== undefined ? $taskTypeStore.get(selectedTaskTypeId) : undefined

  function getClassLabel (sc: ScreenConfig): IntlString | undefined {
    if (sc.targetClass == null || sc.targetClass === '') return undefined

    // 1. If screen is attached to base Issue class, it applies to Any task type
    if (sc.targetClass === tracker.class.Issue) {
      return plugin.string.AnyTaskType
    }

    // 2. If target task type is selected for this import, use its name
    if (targetTaskType !== undefined) {
      return getEmbeddedLabel(targetTaskType.name)
    }

    // 3. Match task type by targetClass
    const match = Array.from($taskTypeStore.values()).find((t) => t.targetClass === sc.targetClass)
    if (match !== undefined) {
      return getEmbeddedLabel(match.name)
    }

    // 4. Hierarchy class lookup or fallback
    return (
      hierarchy.findClass(sc.targetClass)?.label ?? getEmbeddedLabel(sc.targetClass.split(':').pop() ?? sc.targetClass)
    )
  }
</script>

<div class="form-section">
  {#if parsedConfig?.screens !== undefined && parsedConfig.screens.length > 0}
    <div class="section-header font-medium-14 mb-3">
      <Label label={plugin.string.ScreensFoundInWorkflow} />
    </div>

    <div class="screens-detailed-list flex-col flex-gap-3">
      {#each parsedConfig.screens as sc (sc.name)}
        {@const usedTransitions = getTransitionsUsingScreen(sc, parsedConfig, anyStatusLabel)}
        {@const currentRes = screenResolutions[sc.id] ?? screenResolutions[sc.name] ?? { action: 'copy' }}
        {@const reportItem = report?.screens?.find((r) => r.sourceScreenId === sc.id || r.name === sc.name)}
        {@const isExactMatch = reportItem?.isExactMatch === true}
        {@const classLabel = getClassLabel(sc)}
        <div class="screen-detail-card" class:disabled={currentRes.action === 'skip'}>
          <!-- Screen Card Header -->
          <div class="screen-header-row flex-row-center flex-between flex-gap-2">
            <div class="flex-row-center flex-gap-2 min-w-0 screen-main-info">
              <div class="screen-icon-box flex-center">
                <Icon icon={plugin.icon.Screen} size="small" />
              </div>
              <span class="font-medium-14 screen-title" title={sc.name}>{sc.name}</span>
            </div>

            <!-- Segmented Action Switch (Contextual) + Warning on Skip -->
            <div class="screen-actions-wrapper flex-row-center flex-gap-2 flex-shrink-0">
              {#if currentRes.action === 'skip' && usedTransitions.length > 0}
                <div
                  class="screen-skipped-warning flex-center"
                  use:tooltip={{
                    label: plugin.string.ScreenSkippedTransitionsWarning,
                    props: { transitions: usedTransitions.join(', ') }
                  }}
                >
                  <IconError size="small" />
                </div>
              {/if}

              <div class="screen-action-segmented flex-row-center">
                {#if isExactMatch}
                  <button
                    type="button"
                    class="action-btn"
                    class:selected={currentRes.action === 'copy' && currentRes.targetScreenId !== undefined}
                    on:click={() => {
                      screenResolutions[sc.id] = {
                        action: 'copy',
                        targetScreenId: reportItem?.matchingScreenId
                      }
                      screenResolutions = { ...screenResolutions }
                    }}
                  >
                    <Label label={plugin.string.UseExistingScreen} />
                  </button>
                  <button
                    type="button"
                    class="action-btn"
                    class:selected={currentRes.action === 'copy' && currentRes.targetScreenId === undefined}
                    on:click={() => {
                      screenResolutions[sc.id] = { action: 'copy', targetScreenId: undefined }
                      screenResolutions = { ...screenResolutions }
                    }}
                  >
                    <Label label={plugin.string.CreateCopy} />
                  </button>
                  <button
                    type="button"
                    class="action-btn"
                    class:selected={currentRes.action === 'skip'}
                    on:click={() => {
                      screenResolutions[sc.id] = { action: 'skip' }
                      screenResolutions = { ...screenResolutions }
                    }}
                  >
                    <Label label={plugin.string.ActionSkip} />
                  </button>
                {:else}
                  <button
                    type="button"
                    class="action-btn"
                    class:selected={currentRes.action === 'copy'}
                    on:click={() => {
                      screenResolutions[sc.id] = { action: 'copy', targetScreenId: undefined }
                      screenResolutions = { ...screenResolutions }
                    }}
                  >
                    <Label label={plugin.string.ActionCreate} />
                  </button>
                  <button
                    type="button"
                    class="action-btn"
                    class:selected={currentRes.action === 'skip'}
                    on:click={() => {
                      screenResolutions[sc.id] = { action: 'skip' }
                      screenResolutions = { ...screenResolutions }
                    }}
                  >
                    <Label label={plugin.string.ActionSkip} />
                  </button>
                {/if}
              </div>
            </div>
          </div>

          <!-- Matching Info / Description Row -->
          {#if classLabel || isExactMatch || sc.description}
            <div class="screen-sub-row flex-row-center flex-gap-2 flex-wrap">
              {#if classLabel}
                <span class="screen-class flex-shrink-0" title={classLabel}>
                  <Label label={classLabel} />
                </span>
              {/if}
              {#if isExactMatch}
                <span class="exact-match-badge font-regular-12">
                  <Label label={plugin.string.ScreenMatchesExisting} />
                </span>
              {/if}
              {#if sc.description}
                <span class="font-regular-12 text-secondary">{sc.description}</span>
              {/if}
            </div>
          {/if}

          {#if currentRes.action !== 'skip'}
            <!-- Fields Breakdown -->
            {#if sc.tabs !== undefined && sc.tabs.length > 0}
              {@const totalFieldsCount = sc.tabs.reduce((sum, tab) => sum + (tab.fields?.length ?? 0), 0)}
              {#if totalFieldsCount > 0}
                <div class="screen-fields-container flex-col flex-gap-2">
                  {#if sc.tabs.length === 1}
                    <div class="fields-header flex-row-center flex-gap-1 font-medium-12 text-secondary">
                      <Icon icon={plugin.icon.ScreenTab} size="small" />
                      <span><Label label={plugin.string.Fields} /> ({totalFieldsCount})</span>
                    </div>

                    <div class="fields-grid">
                      {#each sc.tabs[0].fields ?? [] as f (f.fieldKey)}
                        <div class="field-pill flex-row-center">
                          <span class="field-label">
                            <Label
                              label={getFieldIntlLabel(
                                f.fieldKey,
                                report,
                                parsedConfig,
                                targetTaskType,
                                hierarchy,
                                f.attribute
                              )}
                            />
                          </span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    {#each sc.tabs as tab (tab.name)}
                      {#if tab.fields !== undefined && tab.fields.length > 0}
                        <div class="tab-group flex-col flex-gap-1-5">
                          <div class="tab-header font-medium-12 text-secondary flex-row-center flex-gap-1">
                            <Icon icon={plugin.icon.ScreenTab} size="small" />
                            <span>
                              <Label label={plugin.string.Tab} /> «{tab.name}»
                            </span>
                            <span class="tab-count">
                              ({tab.fields.length})
                            </span>
                          </div>

                          <div class="fields-grid">
                            {#each tab.fields as f (f.fieldKey)}
                              <div class="field-pill flex-row-center">
                                <span class="field-label">
                                  <Label
                                    label={getFieldIntlLabel(
                                      f.fieldKey,
                                      report,
                                      parsedConfig,
                                      targetTaskType,
                                      hierarchy,
                                      f.attribute
                                    )}
                                  />
                                </span>
                              </div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    {/each}
                  {/if}
                </div>
              {/if}
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style lang="scss">
  .form-section {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .section-header {
    color: var(--theme-content-color, #1a1a1a);
    margin-bottom: var(--spacing-2);
  }

  .screens-detailed-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
  }

  .screen-detail-card {
    padding: 1rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    background-color: var(--theme-card-bg, #ffffff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition:
      background-color 0.2s ease,
      border-color 0.2s ease;

    &.disabled {
      background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.02));
      border-color: var(--theme-divider-color, rgba(0, 0, 0, 0.05));

      .screen-main-info {
        opacity: 0.5;
      }
    }
  }

  .screen-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: nowrap;
    gap: 0.75rem;
    width: 100%;
    min-width: 0;
  }

  .screen-main-info {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  .screen-sub-row {
    margin-top: -0.25rem;
  }

  .screen-actions-wrapper {
    flex-shrink: 0;
    margin-left: auto;
  }

  .screen-icon-box {
    width: 2rem;
    height: 2rem;
    border-radius: 0.375rem;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.04));
    color: var(--theme-content-color, #1a1a1a);
    flex-shrink: 0;
  }

  .screen-title {
    color: var(--theme-content-color, #1a1a1a);
    font-weight: 500;
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .screen-class {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    max-width: 18rem;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1rem;
    letter-spacing: 0.01em;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--text-editor-selected-node-background, rgba(76, 56, 189, 0.12));
    color: var(--primary-color-purple-02, #6452db);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .exact-match-badge {
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--global-success-highlight-BackgroundColor, rgba(46, 160, 67, 0.1));
    border: 1px solid var(--global-success-BorderColor, rgba(46, 160, 67, 0.25));
    color: var(--global-success-TextColor, #2ea043);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .screen-skipped-warning {
    color: #e36209;
    cursor: default;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.375rem;
    background-color: rgba(227, 98, 9, 0.12);
    border: 1px solid rgba(227, 98, 9, 0.35);
    flex-shrink: 0;
    opacity: 1 !important;
    transition: all 0.15s ease;

    &:hover {
      background-color: rgba(227, 98, 9, 0.2);
      border-color: rgba(227, 98, 9, 0.6);
      transform: scale(1.05);
    }
  }

  .screen-action-segmented {
    display: inline-flex;
    align-items: center;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.05));
    border-radius: 0.5rem;
    padding: 3px;
    gap: 2px;
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.06));
    flex-shrink: 0;
    max-width: 100%;

    .action-btn {
      border: none;
      background: transparent;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--theme-secondary-color, #666);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;

      &:hover:not(.selected):not([disabled]) {
        color: var(--theme-content-color, #1a1a1a);
        background-color: rgba(0, 0, 0, 0.04);
      }

      &.selected {
        background-color: var(--theme-card-bg, #ffffff);
        color: var(--primary-color-purple-02, #6452db);
        font-weight: 600;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }

      &[disabled],
      &.disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    }
  }

  .screen-replace-target-row {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.02));
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.06));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;

    .replace-dropdown-wrapper {
      min-width: 180px;
      max-width: 260px;
      flex: 1;
    }
  }

  .screen-fields-container {
    background-color: var(--theme-button-hover-bg, rgba(0, 0, 0, 0.025));
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.06));
    border-radius: 0.5rem;
    padding: 0.625rem 0.875rem;
  }

  .fields-header {
    margin-bottom: 0.25rem;
  }

  .tab-group {
    padding: 0.125rem 0;

    &:not(:first-child) {
      margin-top: 0.375rem;
      padding-top: 0.375rem;
      border-top: 1px dashed var(--theme-divider-color, rgba(0, 0, 0, 0.06));
    }
  }

  .tab-header {
    margin-bottom: 0.25rem;
  }

  .fields-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .field-pill {
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    background-color: var(--theme-card-bg, #ffffff);
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    font-size: 0.75rem;
    color: var(--theme-content-color, #1a1a1a);
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 400;
  }
</style>
