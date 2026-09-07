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
  import { type Ref, type Status } from '@hcengineering/core'
  import { Severity, Status as PlatformStatus, setPlatformStatus } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { type ProjectType, type TaskType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import { closePopup, type IWizardStep, ModernWizardDialog } from '@hcengineering/ui'
  import { statusStore } from '@hcengineering/view-resources'
  import workflow, {
    checkWorkflowCompatibility,
    importWorkflowConfig,
    type AttributeResolutionConfig,
    type ScreenResolutionConfig,
    type WorkflowCompatibilityReport,
    type WorkflowConfig,
    type WorkflowImportResolution
  } from '@hcengineering/workflow'

  import { navigateToWorkflow } from '../../location'
  import plugin from '../../plugin'
  import ImportAttributesStep from './import/ImportAttributesStep.svelte'
  import ImportFileStep from './import/ImportFileStep.svelte'
  import ImportGeneralStep from './import/ImportGeneralStep.svelte'
  import ImportScreensStep from './import/ImportScreensStep.svelte'
  import ImportStatusesStep from './import/ImportStatusesStep.svelte'
  import {
    computeInitialAttributeResolutions,
    computeInitialScreenResolutions,
    computeInitialStatusMap,
    getAttributeUsageLocations,
    hasDuplicateTargetStatuses
  } from './import/utils'

  // --- Props ---
  export let projectType: ProjectType
  export let initialConfig: WorkflowConfig | null = null
  export let initialFileName: string = ''
  export let initialText: string = ''

  // --- Services ---
  const client = getClient()
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: void }>()

  let fileStepRef: ImportFileStep | undefined

  // --- Form & Resolutions State ---
  let parsedConfig: WorkflowConfig | null = initialConfig
  let workflowName = initialConfig?.workflows?.[0]?.name ?? ''
  let selectedTaskTypeId: Ref<TaskType> | undefined = undefined
  let hasRawJsonText = (initialText ?? '').trim().length > 0
  let rawJsonText = initialText ?? ''

  $: if (selectedTaskTypeId === undefined) {
    const firstTt = Array.from($taskTypeStore.values()).find((tt) => tt.parent === projectType._id)
    if (firstTt !== undefined) {
      selectedTaskTypeId = firstTt._id
    }
  }

  let report: WorkflowCompatibilityReport | null = null
  let statusMap: Record<Ref<Status>, Ref<Status> | undefined> = {}
  let screenResolutions: Record<string, ScreenResolutionConfig> = {}
  let attributeResolutions: Record<string, AttributeResolutionConfig> = {}
  let createMissingStatuses = true
  let isSaving = false

  // --- Wizard Navigation State ---
  let selectedStep = initialConfig != null ? 'general' : 'file'

  $: activeAttributesToCreate = (
    report?.attributes.filter((a) => !a.unresolvable && a.targetAttributeId === undefined) ?? []
  ).filter(
    (a) => getAttributeUsageLocations(a.fieldKey, a.sourceAttributeId, parsedConfig, screenResolutions).length > 0
  )
  $: activeUnresolvableAttrs = (report?.attributes.filter((a) => a.unresolvable) ?? []).filter(
    (a) => getAttributeUsageLocations(a.fieldKey, a.sourceAttributeId, parsedConfig, screenResolutions).length > 0
  )

  // --- Step Configuration ---
  $: steps = ((): IWizardStep[] => {
    const res: IWizardStep[] = [
      { id: 'file', title: plugin.string.StepSelectFile },
      { id: 'general', title: plugin.string.StepGeneral },
      { id: 'statuses', title: plugin.string.StepStatuses }
    ]
    if (report?.hasScreens === true) {
      res.push({ id: 'screens', title: plugin.string.StepScreens })
    }
    if (activeAttributesToCreate.length > 0 || activeUnresolvableAttrs.length > 0) {
      res.push({ id: 'attributes', title: plugin.string.StepAttributes })
    }
    return res
  })()

  $: if (!steps.some((s) => s.id === selectedStep)) {
    selectedStep = steps[0]?.id ?? 'file'
  }

  $: canProceed = ((): boolean => {
    if (selectedStep === 'file') return parsedConfig != null || hasRawJsonText
    if (selectedStep === 'general') {
      return parsedConfig != null && workflowName.trim() !== '' && selectedTaskTypeId !== undefined
    }
    if (selectedStep === 'statuses') return !hasDuplicateTargetStatuses(statusMap)
    return true
  })()

  $: canSubmit =
    parsedConfig != null &&
    workflowName.trim() !== '' &&
    selectedTaskTypeId !== undefined &&
    !hasDuplicateTargetStatuses(statusMap) &&
    !isSaving

  // --- Compatibility & Screen Init ---
  $: if (parsedConfig != null && selectedTaskTypeId !== undefined) {
    void loadCompatibilityReport(selectedTaskTypeId, parsedConfig)
  }

  async function loadCompatibilityReport (targetTaskTypeId: Ref<TaskType>, config: WorkflowConfig): Promise<void> {
    try {
      const rep = await checkWorkflowCompatibility(client, config, targetTaskTypeId)
      report = rep

      const targetTt = $taskTypeStore.get(targetTaskTypeId)
      const targetStatuses = (targetTt?.statuses ?? [])
        .map((sId) => $statusStore.byId.get(sId))
        .filter((s): s is Status => s !== undefined)

      const existingScreens = await client.findAll(workflow.class.Screen, { projectType: projectType._id })

      statusMap = computeInitialStatusMap(rep.statuses, targetStatuses)
      attributeResolutions = computeInitialAttributeResolutions(rep.attributes)
      screenResolutions = computeInitialScreenResolutions(config.screens, existingScreens, rep.screens)
    } catch (err) {
      console.error('Failed to check compatibility for import', err)
    }
  }

  function handleFileLoaded (e: CustomEvent<{ config: WorkflowConfig, workflowName: string }>): void {
    parsedConfig = e.detail.config
    workflowName = e.detail.workflowName
    selectedStep = 'general'
  }

  function handleFileReset (): void {
    parsedConfig = null
    report = null
    hasRawJsonText = false
    rawJsonText = ''
    selectedStep = 'file'
  }

  function handleStepChanged (e: CustomEvent<string>): void {
    const targetStep = e.detail
    if (selectedStep === 'file' && targetStep !== 'file' && parsedConfig == null) {
      const ok = fileStepRef?.tryCommit() === true
      if (!ok) return
    }
    if (
      selectedStep === 'general' &&
      targetStep !== 'file' &&
      (workflowName.trim() === '' || selectedTaskTypeId === undefined)
    ) {
      return
    }
    if (
      selectedStep === 'statuses' &&
      (targetStep === 'screens' || targetStep === 'attributes') &&
      hasDuplicateTargetStatuses(statusMap)
    ) {
      return
    }
    selectedStep = targetStep
  }

  async function handleSubmit (): Promise<void> {
    if (!canSubmit || parsedConfig == null || selectedTaskTypeId === undefined) return
    isSaving = true
    try {
      const resolution: WorkflowImportResolution = {
        targetTaskTypeId: selectedTaskTypeId,
        statusMap,
        attributeResolutions,
        screenResolutions,
        copyScreens: true,
        createMissingStatuses,
        name: workflowName.trim()
      }
      const result = await importWorkflowConfig(client, projectType._id, parsedConfig, resolution)
      const firstWf = parsedConfig.workflows[0]
      const createdId =
        (firstWf !== undefined ? result.workflows[firstWf.id] : undefined) ?? Object.values(result.workflows)[0]
      closePopup()
      dispatch('close')
      if (createdId !== undefined) {
        navigateToWorkflow(createdId)
      }
    } catch (err: any) {
      console.error('Failed to import workflow', err)
      await setPlatformStatus(
        new PlatformStatus(Severity.ERROR, plugin.string.InvalidWorkflowFile, {}, undefined, {
          timeout: 4000
        })
      )
    } finally {
      isSaving = false
    }
  }
</script>

<ModernWizardDialog
  width="56rem"
  loading={isSaving}
  label={plugin.string.Import}
  submitLabel={plugin.string.Import}
  {canSubmit}
  {canProceed}
  {steps}
  {selectedStep}
  on:stepChanged={handleStepChanged}
  on:submit={handleSubmit}
  on:close={() => {
    closePopup()
    dispatch('close')
  }}
>
  <div class="root">
    {#if selectedStep === 'file'}
      <ImportFileStep
        bind:this={fileStepRef}
        bind:config={parsedConfig}
        bind:workflowName
        bind:hasText={hasRawJsonText}
        bind:rawJsonText
        {initialFileName}
        {initialText}
        {isSaving}
        on:loaded={handleFileLoaded}
        on:reset={handleFileReset}
      />
    {:else if selectedStep === 'general'}
      <ImportGeneralStep {projectType} bind:workflowName bind:selectedTaskTypeId />
    {:else if selectedStep === 'statuses'}
      <ImportStatusesStep {projectType} {selectedTaskTypeId} {report} bind:statusMap bind:createMissingStatuses />
    {:else if selectedStep === 'screens'}
      <ImportScreensStep {projectType} {selectedTaskTypeId} {parsedConfig} bind:screenResolutions {report} />
    {:else if selectedStep === 'attributes'}
      <ImportAttributesStep
        {projectType}
        {selectedTaskTypeId}
        {report}
        {parsedConfig}
        {screenResolutions}
        bind:attributeResolutions
      />
    {/if}
  </div>
</ModernWizardDialog>

<style lang="scss">
  .root {
    min-height: 28rem;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-2);
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
</style>
