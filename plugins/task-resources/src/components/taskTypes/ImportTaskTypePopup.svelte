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
  import { createEventDispatcher, onMount } from 'svelte'
  import { type Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { Severity, Status, getEmbeddedLabel, setPlatformStatus, translateCB } from '@hcengineering/platform'
  import task, {
    ProjectType,
    TaskType,
    TaskTypeConfigEntry,
    TaskTypeExportConfig,
    findIncompatibleAttributes,
    importTaskTypeConfig
  } from '@hcengineering/task'
  import { Icon, IconError, type IWizardStep, Label, ModernWizardDialog, themeStore, tooltip } from '@hcengineering/ui'

  import plugin from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'
  import TaskTypeSelectList from './TaskTypeSelectList.svelte'
  import { type TaskTypeRelation, type TaskTypeSelectItem } from './types'

  export let projectType: ProjectType
  export let taskTypes: TaskType[] = []
  export let initialConfig: TaskTypeExportConfig | null = null
  export let initialText: string = ''

  const client = getClient()
  const dispatch = createEventDispatcher()

  let fileInput: HTMLInputElement | undefined
  let textAreaEl: HTMLTextAreaElement | undefined
  let rawJsonText = initialText
  let placeholderText = ''
  let parsedConfig: TaskTypeExportConfig | null = initialConfig
  let parseError: string | null = initialText.trim().length > 0 && initialConfig == null ? 'InvalidFormat' : null

  // Keyed by entry id: a hand-edited or API-produced file may repeat a name.
  let selectedIds = new Set<Ref<TaskType>>(initialConfig?.taskTypes?.map((t) => t.id) ?? [])
  let isImporting = false

  let selectedStep: string = initialConfig != null ? 'types' : 'source'
  // Text the current parsedConfig was produced from; lets us tell an edited source apart from an untouched one
  let appliedText: string = initialConfig != null ? initialText : ''

  const steps: IWizardStep[] = [
    { id: 'source', title: plugin.string.StepSelectSource },
    { id: 'types', title: plugin.string.StepSelectTaskTypes }
  ]

  $: translateCB(plugin.string.PasteJsonPlaceholder, {}, $themeStore.language, (res) => {
    placeholderText = res
  })

  onMount(() => {
    if (parsedConfig == null && textAreaEl !== undefined) {
      textAreaEl.focus()
      textAreaEl.scrollTop = 0
      textAreaEl.setSelectionRange(0, 0)
    }
  })

  $: existingTypeNames = new Set(taskTypes.filter((t) => t.name != null).map((t) => t.name.trim().toLowerCase()))

  $: entries = parsedConfig?.taskTypes ?? []
  $: selectedCount = selectedIds.size
  $: canProceed = (parsedConfig != null && rawJsonText === appliedText) || rawJsonText.trim().length > 0
  $: canImport = parsedConfig != null && selectedCount > 0 && !isImporting
  $: incompatibleAttrs =
    parsedConfig != null ? findIncompatibleAttributes(client, parsedConfig, Array.from(selectedIds)) : []

  interface GroupedReasons {
    parentOf: Array<Ref<TaskType>>
    childOf: Array<Ref<TaskType>>
    universalChild?: boolean
  }

  // allowedAsChildOf holds refs from the source workspace, so resolve through the file's own entries
  // first and fall back to existing types for refs that happen to match.
  $: typeNameById = new Map<string, string>([
    ...(taskTypes ?? []).filter((t) => t.name != null).map((t) => [t._id, t.name] as [string, string]),
    ...(entries ?? []).filter((e) => e.id != null).map((e) => [e.id as string, e.name] as [string, string])
  ])

  // Same as the export dialog: an unresolved id is dropped rather than rendered as a name.
  function toRelations (ids: Array<Ref<TaskType>>, names: Map<string, string>): TaskTypeRelation[] {
    return ids
      .map((id) => {
        const name = names.get(id)
        return name !== undefined ? { id, name } : undefined
      })
      .filter((r): r is TaskTypeRelation => r !== undefined)
  }

  // The file records which type the export was started from; it is always imported,
  // so it is shown above the list and cannot be unchecked.
  $: mainEntry = ((): TaskTypeConfigEntry | undefined => {
    if (parsedConfig == null || entries.length === 0) return undefined
    const byId = entries.find((e) => e.id === parsedConfig?.taskTypeId)
    if (byId !== undefined) return byId
    return entries.find((e) => e.name === parsedConfig?.taskTypeName)
  })()

  $: relatedEntries = entries.filter((e) => e !== mainEntry)

  $: selectedRelatedIds = new Set<string>([...selectedIds].filter((id) => id !== mainEntry?.id))

  $: listItems = relatedEntries.map((entry) => {
    const grp = computeEntryReasons(entry, entries)
    return {
      id: entry.id,
      name: entry.name,
      icon: entry,
      parentOf: toRelations(grp.parentOf, typeNameById),
      childOf: toRelations(grp.childOf, typeNameById),
      universalChild: grp.universalChild,
      exists: existingTypeNames.has(entry.name.trim().toLowerCase())
    } satisfies TaskTypeSelectItem
  })

  function computeEntryReasons (entry: TaskTypeConfigEntry, allEntries: TaskTypeConfigEntry[]): GroupedReasons {
    const parentOf: Array<Ref<TaskType>> = []
    const childOf: Array<Ref<TaskType>> = []
    let universalChild = false

    if (allEntries.length <= 1) {
      return { parentOf, childOf, universalChild }
    }

    // Mirrors computeDependencyReasons() used by the export dialog, so both show the same relations.
    if (entry.allowAnyParent === true) {
      universalChild = true
    }
    if (entry.allowedAsChildOf !== undefined) {
      for (const pId of entry.allowedAsChildOf) {
        // the export only names parents present in the same file; ids from outside would render raw
        const known = allEntries.some((e) => e.id === pId)
        if (known && !childOf.includes(pId)) {
          childOf.push(pId)
        }
      }
    }

    // Check if this entry is an allowed parent for other entries in the file
    for (const other of allEntries) {
      if (other.name !== entry.name && other.allowedAsChildOf !== undefined) {
        const isParent = other.allowedAsChildOf.some(
          (pId) => pId === entry.id || (entry.id == null && pId === (entry.name as any))
        )
        if (isParent) {
          const id = other.id ?? other.name
          if (!parentOf.includes(id)) {
            parentOf.push(id)
          }
        }
      }
    }

    return { parentOf, childOf, universalChild }
  }

  function processJsonText (text: string, sourceName: string): boolean {
    if (text.trim().length === 0) {
      parseError = sourceName === 'Clipboard' ? 'ClipboardEmpty' : 'InvalidFormat'
      parsedConfig = null
      return false
    }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      parseError = 'InvalidFormat'
      parsedConfig = null
      return false
    }

    if (json == null || typeof json !== 'object' || !Array.isArray(json.taskTypes) || json.taskTypes.length === 0) {
      parseError = 'InvalidFormat'
      parsedConfig = null
      return false
    }

    // json comes from a user-supplied file, so entries are narrowed here rather than trusted
    const validEntries: TaskTypeConfigEntry[] = json.taskTypes.filter(
      (t: any): t is TaskTypeConfigEntry => t != null && typeof t.name === 'string' && t.name.trim() !== ''
    )
    if (validEntries.length === 0) {
      parseError = 'InvalidFormat'
      parsedConfig = null
      return false
    }

    parsedConfig = json as TaskTypeExportConfig
    parseError = null
    selectedIds = new Set(validEntries.map((t) => t.id))
    appliedText = text
    selectedStep = 'types'
    return true
  }

  async function handleFileChange (event: Event): Promise<void> {
    const target = event.target as HTMLInputElement
    const files = target.files
    if (files == null || files.length === 0) return

    const file = files[0]
    if (!file.name.toLowerCase().endsWith('.json')) {
      parseError = 'InvalidFileType'
      parsedConfig = null
      return
    }

    try {
      const text = await file.text()
      const ok = processJsonText(text, file.name)
      if (ok) {
        rawJsonText = text
      } else {
        parseError = 'InvalidTaskTypeFile'
      }
    } catch {
      parseError = 'InvalidTaskTypeFile'
      parsedConfig = null
    }
  }

  function handleTextInput (): void {
    if (parseError != null) {
      parseError = null
    }
  }

  function handleTextPaste (): void {
    if (parseError != null) {
      parseError = null
    }
    setTimeout(() => {
      if (textAreaEl !== undefined) {
        textAreaEl.scrollTop = 0
        textAreaEl.setSelectionRange(0, 0)
      }
    }, 0)
  }

  function handleStepChanged (e: CustomEvent<string>): void {
    const target = e.detail
    if (target === 'types') {
      // Re-parse only when the pasted text differs from what the current config was built from,
      // so returning from "Change file" without edits keeps the previously chosen source.
      if (parsedConfig == null || rawJsonText !== appliedText) {
        if (rawJsonText.trim().length === 0) {
          parseError = 'InvalidFormat'
          return
        }
        // processJsonText advances the step itself on success
        processJsonText(rawJsonText, 'Clipboard')
        return
      }
      parseError = null
    }
    selectedStep = target
  }

  // The shared list is key-agnostic and reports string ids; every row here is keyed by an entry id.
  function toggleEntry (rowId: string): void {
    const id = rowId as Ref<TaskType>
    if (id === mainEntry?.id) return
    if (selectedIds.has(id)) {
      selectedIds.delete(id)
    } else {
      selectedIds.add(id)
    }
    selectedIds = new Set(selectedIds)
  }

  function selectAll (): void {
    if (parsedConfig == null) return
    selectedIds = new Set(parsedConfig.taskTypes.map((t) => t.id))
  }

  function deselectAll (): void {
    // the main type is always imported
    selectedIds = new Set(mainEntry !== undefined ? [mainEntry.id] : [])
  }

  async function handleImport (): Promise<void> {
    if (!canImport || parsedConfig == null) return

    isImporting = true
    try {
      await importTaskTypeConfig(client, projectType._id, parsedConfig, {
        selectedTypeIds: Array.from(selectedIds),
        renameDuplicates: true
      })
      dispatch('close')
    } catch (err) {
      console.error('Failed to import task types', err)
      await setPlatformStatus(
        new Status(Severity.ERROR, plugin.status.ImportTaskTypeError, {}, undefined, { timeout: 5000 })
      )
      return
    } finally {
      isImporting = false
    }
  }

  function handleWindowPaste (event: ClipboardEvent): void {
    if (selectedStep !== 'source' || isImporting) return
    if (document.activeElement !== textAreaEl) {
      const text = event.clipboardData?.getData('text')
      if (text != null && text.trim().length > 0) {
        rawJsonText = text
        parseError = null
        setTimeout(() => {
          if (textAreaEl !== undefined) {
            textAreaEl.scrollTop = 0
            textAreaEl.setSelectionRange(0, 0)
          }
        }, 0)
      }
    }
  }

  function handleClose (): void {
    dispatch('close')
  }
</script>

<svelte:window on:paste={handleWindowPaste} />

<ModernWizardDialog
  width="56rem"
  loading={isImporting}
  label={plugin.string.ImportTaskTypesDialogTitle}
  submitLabel={plugin.string.Import}
  canSubmit={canImport}
  {canProceed}
  {steps}
  {selectedStep}
  on:stepChanged={handleStepChanged}
  on:submit={handleImport}
  on:close={handleClose}
>
  <div class="import-dialog-body flex-col flex-gap-4">
    <input type="file" accept=".json" bind:this={fileInput} style="display: none;" on:change={handleFileChange} />

    {#if selectedStep === 'source'}
      <!-- Step 1: Text Area for pasting JSON + file selection link -->
      <div class="json-input-card flex-col flex-gap-3">
        <div class="textarea-wrapper">
          <textarea
            class="json-textarea font-regular-14"
            bind:value={rawJsonText}
            bind:this={textAreaEl}
            placeholder={placeholderText}
            on:input={handleTextInput}
            on:paste={handleTextPaste}
            spellcheck="false"
          />
        </div>

        <div class="json-input-footer flex-row-center justify-between flex-wrap">
          {#if parseError != null}
            <div class="error-banner flex-row-center flex-gap-1-5">
              <IconError size="small" />
              <span class="font-regular-12 error-text">
                {#if parseError === 'InvalidFileType'}
                  <Label label={plugin.string.InvalidFileType} />
                {:else if parseError === 'InvalidTaskTypeFile'}
                  <Label label={plugin.string.InvalidTaskTypeFile} />
                {:else if parseError === 'ClipboardEmpty'}
                  <Label label={plugin.string.ClipboardEmpty} />
                {:else if parseError === 'ClipboardReadError'}
                  <Label label={plugin.string.ClipboardReadError} />
                {:else}
                  <Label label={plugin.string.InvalidFormat} />
                {/if}
              </span>
            </div>
          {:else}
            <div />
          {/if}

          <button
            type="button"
            class="file-link-btn flex-row-center flex-gap-1 font-regular-12"
            on:click={() => fileInput?.click()}
          >
            <Icon icon={task.icon.Import} size="small" />
            <Label label={plugin.string.OrUploadFile} />
          </button>
        </div>
      </div>
    {:else}
      <!-- Step 2: Task Types Checklist -->
      {#if incompatibleAttrs.length > 0}
        <div class="warning-banner flex-col">
          <div class="warning-header flex-row-center flex-gap-2">
            <IconError size="small" />
            <span class="font-medium-12">
              <Label label={plugin.string.IncompatibleAttributesWarning} />
            </span>
          </div>
          <div class="warning-list flex-col">
            {#each incompatibleAttrs as item}
              <span class="warning-item font-normal-11">
                • {item.taskTypeName} → {item.attributeName} ({item.targetClass})
              </span>
            {/each}
          </div>
        </div>
      {/if}

      {#if mainEntry !== undefined}
        <!-- The type the export was started from: always imported, so it sits outside the list -->
        <div class="flex-col flex-gap-1-5">
          <span class="section-caption font-medium-11">
            <Label label={plugin.string.ImportedTaskType} />
          </span>
          <div class="main-type-row flex-row-center flex-gap-2">
            <TaskTypeIcon value={mainEntry} size="small" />
            <span class="main-type-name font-medium-13" use:tooltip={{ label: getEmbeddedLabel(mainEntry.name) }}>
              {mainEntry.name}
            </span>
            {#if existingTypeNames.has(mainEntry.name.trim().toLowerCase())}
              <div class="collision-warning flex-center" use:tooltip={{ label: plugin.string.TaskTypeAlreadyExists }}>
                <IconError size="small" />
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if listItems.length > 0}
        <div class="flex-col flex-gap-1-5">
          <span class="section-caption font-medium-11">
            <Label label={plugin.string.ConnectedTaskTypes} />
          </span>
          <TaskTypeSelectList
            showTitle={false}
            items={listItems}
            selectedIds={selectedRelatedIds}
            on:toggle={(e) => {
              toggleEntry(e.detail)
            }}
            on:selectAll={selectAll}
            on:deselectAll={deselectAll}
          />
        </div>
      {/if}
    {/if}
  </div>
</ModernWizardDialog>

<style lang="scss">
  .import-dialog-body {
    width: 100%;
    box-sizing: border-box;
  }

  .json-input-card {
    width: 100%;
    box-sizing: border-box;
  }

  .textarea-wrapper {
    width: 100%;
    border-radius: var(--border-radius-1, 0.5rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    padding: 0.75rem 0.875rem;
    box-sizing: border-box;
  }

  .json-textarea {
    width: 100%;
    min-height: 8.5rem;
    max-height: 14rem;
    border: 0 !important;
    outline: none !important;
    box-shadow: none !important;
    background: transparent;
    color: var(--theme-caption-color, var(--global-primary-TextColor, #000)) !important;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.45;
    resize: none;
    padding: 0;
    margin: 0;
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--theme-divider-color) transparent;

    &:focus,
    &:focus-visible {
      outline: none !important;
      box-shadow: none !important;
      border: 0 !important;
      color: var(--theme-caption-color, var(--global-primary-TextColor, #000)) !important;
    }

    &::placeholder {
      color: var(--global-tertiary-TextColor, var(--theme-dark-color)) !important;
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 400;
    }
  }

  .json-input-footer {
    width: 100%;
    min-height: 1.75rem;
    gap: 0.5rem;
  }

  .file-link-btn {
    background: none;
    border: none;
    color: var(--theme-secondary-color);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--border-radius-1, 0.375rem);
    transition: all 0.12s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;

    &:hover {
      color: var(--theme-accent-color);
      background: rgba(var(--theme-accent-rgb, 100, 80, 240), 0.08);
    }
  }

  .error-banner {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.25rem;
  }

  .error-text {
    color: var(--theme-error-color, #eb5757);

    :global(.overflow-label) {
      color: var(--theme-error-color, #eb5757);
    }
  }

  .section-caption {
    color: var(--theme-caption-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .main-type-row {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 1rem;
    // matches a TaskTypeSelectList row, so the two blocks read as one scale
    min-height: 2.875rem;
    border-radius: var(--border-radius-1, 0.75rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
  }

  .main-type-name {
    color: var(--theme-content-color);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // Same treatment as the skipped-screen warning in the workflow import wizard
  .collision-warning {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    color: #e36209;
    background-color: rgba(227, 98, 9, 0.12);
    border: 1px solid rgba(227, 98, 9, 0.35);
    cursor: default;
    flex-shrink: 0;
    transition: all 0.15s ease;

    &:hover {
      background-color: rgba(227, 98, 9, 0.2);
      border-color: rgba(227, 98, 9, 0.6);
    }
  }

  .warning-banner {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-warning-highlight-BackgroundColor, rgba(227, 98, 9, 0.08));
    border: 1px solid var(--global-warning-BorderColor, rgba(227, 98, 9, 0.25));
    box-sizing: border-box;
    width: 100%;
  }

  .warning-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--global-warning-TextColor, #e36209);
  }

  .warning-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-left: 1.5rem;
  }

  .warning-item {
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--theme-secondary-color);
  }
</style>
