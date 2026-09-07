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
  import { getClient } from '@hcengineering/presentation'
  import { Severity, Status, setPlatformStatus, translateCB } from '@hcengineering/platform'
  import task, {
    ProjectType,
    TaskType,
    TaskTypeConfigEntry,
    TaskTypeExportConfig,
    findIncompatibleAttributes,
    importTaskTypeConfig
  } from '@hcengineering/task'
  import { Icon, IconCheck, IconError, IconInfo, Label, Modal, ModernCheckbox, themeStore } from '@hcengineering/ui'

  import plugin from '../../plugin'
  import TaskTypeIcon from './TaskTypeIcon.svelte'

  export let projectType: ProjectType
  export let taskTypes: TaskType[] = []
  export let initialConfig: TaskTypeExportConfig | null = null
  export let initialFileName: string = ''
  export let initialText: string = ''

  const client = getClient()
  const dispatch = createEventDispatcher()

  let fileInput: HTMLInputElement | undefined
  let textAreaEl: HTMLTextAreaElement | undefined
  let rawJsonText = initialText
  let placeholderText = ''
  let selectedFileName = initialFileName
  let parsedConfig: TaskTypeExportConfig | null = initialConfig
  let parseError: string | null = initialText.trim().length > 0 && initialConfig == null ? 'InvalidFormat' : null

  let selectedNames = new Set<string>(initialConfig?.taskTypes?.map((t) => t.name) ?? [])
  let isImporting = false

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
  $: selectedCount = selectedNames.size
  $: canImport = (parsedConfig == null ? rawJsonText.trim().length > 0 : selectedCount > 0) && !isImporting
  $: incompatibleAttrs =
    parsedConfig != null ? findIncompatibleAttributes(client, parsedConfig, Array.from(selectedNames)) : []

  interface GroupedReasons {
    parentOf: string[]
    childOf: string[]
    universalChild?: boolean
  }

  $: typeNameById = new Map<string, string>([
    ...(taskTypes ?? []).filter((t) => t.name != null).map((t) => [t._id, t.name] as [string, string]),
    ...(entries ?? []).filter((e) => e.id != null).map((e) => [e.id as string, e.name] as [string, string]),
    ...(entries ?? []).map((e) => [e.name, e.name] as [string, string])
  ])

  function formatTypeNames (ids: string[]): string {
    return ids.map((id) => typeNameById.get(id) ?? id).join(', ')
  }

  function computeEntryReasons (entry: TaskTypeConfigEntry, allEntries: TaskTypeConfigEntry[]): GroupedReasons {
    const parentOf: string[] = []
    const childOf: string[] = []
    let universalChild = false

    if (allEntries.length <= 1) {
      return { parentOf, childOf, universalChild }
    }

    if (entry.allowAnyParent === true) {
      universalChild = true
    } else if (entry.allowedAsChildOf !== undefined) {
      for (const pId of entry.allowedAsChildOf) {
        if (!childOf.includes(pId)) {
          childOf.push(pId)
        }
      }
    }

    // Check if this entry is an allowed parent for other entries in the file
    for (const other of allEntries) {
      if (other.name !== entry.name && other.allowedAsChildOf !== undefined && other.allowAnyParent !== true) {
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

    const validEntries = json.taskTypes.filter(
      (t: any) => t != null && typeof t.name === 'string' && t.name.trim() !== ''
    )
    if (validEntries.length === 0) {
      parseError = 'InvalidFormat'
      parsedConfig = null
      return false
    }

    parsedConfig = json as TaskTypeExportConfig
    parseError = null
    selectedFileName = sourceName
    selectedNames = new Set(validEntries.map((t: any) => t.name))
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
      if (!ok) {
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

  function resetFile (): void {
    parsedConfig = null
    parseError = null
    selectedFileName = ''
    selectedNames.clear()
    if (fileInput !== undefined) {
      fileInput.value = ''
    }
    setTimeout(() => {
      if (textAreaEl !== undefined) {
        textAreaEl.focus()
        textAreaEl.scrollTop = 0
        textAreaEl.setSelectionRange(0, 0)
      }
    }, 0)
  }

  function toggleEntry (name: string): void {
    if (selectedNames.has(name)) {
      selectedNames.delete(name)
    } else {
      selectedNames.add(name)
    }
    selectedNames = new Set(selectedNames)
  }

  function selectAll (): void {
    if (parsedConfig == null) return
    selectedNames = new Set(parsedConfig.taskTypes.map((t) => t.name))
  }

  function deselectAll (): void {
    selectedNames.clear()
    selectedNames = new Set()
  }

  async function handleImport (): Promise<void> {
    if (!canImport || parsedConfig == null) return

    isImporting = true
    try {
      await importTaskTypeConfig(client, projectType._id, parsedConfig, {
        selectedTypeNames: Array.from(selectedNames),
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

  async function handleOkAction (): Promise<void> {
    if (parsedConfig == null) {
      if (rawJsonText.trim().length === 0) {
        parseError = 'InvalidFormat'
        return
      }
      const ok = processJsonText(rawJsonText, 'Clipboard')
      if (!ok) {
        parseError = 'InvalidFormat'
      }
      return
    }

    await handleImport()
  }

  function handleWindowPaste (event: ClipboardEvent): void {
    if (parsedConfig != null || isImporting) return
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

<Modal
  type="type-popup"
  width="medium"
  maxWidth="36rem"
  label={plugin.string.ImportTaskTypesDialogTitle}
  okLabel={plugin.string.Import}
  okAction={handleOkAction}
  okLoading={isImporting}
  canSave={canImport}
  onCancel={handleClose}
>
  <div class="import-dialog-body flex-col flex-gap-4">
    <input type="file" accept=".json" bind:this={fileInput} style="display: none;" on:change={handleFileChange} />

    {#if parsedConfig == null}
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
      <!-- Step 2: File/Clipboard Selected + Task Types Checklist -->
      <div class="file-selected-card flex-row-center justify-between">
        <div class="flex-row-center flex-gap-2">
          <div class="success-icon flex-center">
            <IconCheck size="small" />
          </div>
          <div class="file-meta flex-col">
            <span class="font-medium-13">
              {#if selectedFileName === 'Clipboard'}
                <Label label={plugin.string.ClipboardSource} />
              {:else}
                {selectedFileName}
              {/if}
            </span>
            <span class="font-normal-11 text-secondary">
              {entries.length}
              {entries.length === 1 ? 'тип' : 'типов'}
            </span>
          </div>
        </div>
        <button type="button" class="btn-change-file font-medium-12" on:click={resetFile}>
          <Label label={plugin.string.ChangeFile} />
        </button>
      </div>

      <!-- Hint banner styled like workflow validators -->
      <div class="mode-hint">
        <div class="mode-hint-icon">
          <IconInfo size="small" />
        </div>
        <span class="mode-hint-text">
          <Label label={plugin.string.ImportTaskTypesHint} />
        </span>
      </div>

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

      <!-- Task Types Checklist Card -->
      <div class="hierarchy-card flex-col">
        <div class="hierarchy-header flex-row-center justify-between">
          <span class="hierarchy-title font-medium-11">
            <Label label={plugin.string.TaskTypes} />
            <span class="count-pill font-normal-11">
              {selectedCount} / {entries.length}
            </span>
          </span>
          <div class="header-actions flex-row-center flex-gap-1">
            <button
              type="button"
              class="btn-link font-normal-12"
              class:disabled={selectedCount === entries.length}
              disabled={selectedCount === entries.length}
              on:click={selectAll}
            >
              <Label label={plugin.string.SelectAll} />
            </button>
            <span class="dot-sep">•</span>
            <button
              type="button"
              class="btn-link font-normal-12"
              class:disabled={selectedCount === 0}
              disabled={selectedCount === 0}
              on:click={deselectAll}
            >
              <Label label={plugin.string.DeselectAll} />
            </button>
          </div>
        </div>

        <div class="hierarchy-list flex-col">
          {#each entries as entry (entry.name)}
            {@const isChecked = selectedNames.has(entry.name)}
            {@const isExisting = existingTypeNames.has(entry.name.trim().toLowerCase())}
            {@const grp = computeEntryReasons(entry, entries)}
            <div
              class="type-row flex-row-center"
              class:checked={isChecked}
              class:unchecked={!isChecked}
              on:click={() => {
                toggleEntry(entry.name)
              }}
            >
              <div class="checkbox-slot" on:click|stopPropagation>
                <ModernCheckbox
                  checked={isChecked}
                  on:change={() => {
                    toggleEntry(entry.name)
                  }}
                />
              </div>
              <div class="icon-slot">
                <TaskTypeIcon value={entry} size="small" />
              </div>
              <span class="type-name font-medium-13">{entry.name}</span>

              {#if isExisting}
                <span class="collision-badge font-normal-11">
                  <Label label={plugin.string.TaskTypeAlreadyExists} />
                </span>
              {/if}

              {#if entries.length > 1}
                <div class="relations-wrap">
                  {#if grp.parentOf.length > 0}
                    <span class="relation-badge">
                      <span class="badge-role"><Label label={plugin.string.ParentOf} />:</span>
                      <span class="badge-names">{formatTypeNames(grp.parentOf)}</span>
                    </span>
                  {/if}
                  {#if grp.universalChild}
                    <span class="relation-badge">
                      ↳ <Label label={plugin.string.UniversalChildRelation} />
                    </span>
                  {:else if grp.childOf.length > 0}
                    <span class="relation-badge">
                      <span class="badge-role">↳ <Label label={plugin.string.ChildOf} />:</span>
                      <span class="badge-names">{formatTypeNames(grp.childOf)}</span>
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  :global(.hulyModal-container.type-popup) {
    height: auto;

    textarea.json-textarea {
      color: var(--theme-caption-color, var(--global-primary-TextColor, #000)) !important;
    }
  }

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

  .file-selected-card {
    width: 100%;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    box-sizing: border-box;
  }

  .success-icon {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: rgba(46, 160, 67, 0.15);
    color: #2ea043;
  }

  .file-meta {
    gap: 0.125rem;
  }

  .text-secondary {
    color: var(--theme-secondary-color);
  }

  .btn-change-file {
    background: none;
    border: none;
    color: var(--theme-accent-color);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;

    &:hover {
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

  .mode-hint {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.55rem 0.875rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: var(--global-ui-highlight-BackgroundColor, var(--theme-table-row-color, var(--theme-card-bg)));
    box-sizing: border-box;
    width: 100%;
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

  .mode-hint-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--theme-secondary-color);
    flex-shrink: 0;
  }

  .mode-hint-text {
    font-size: 0.8125rem;
    line-height: 1.35;
    color: var(--theme-secondary-color);
    flex: 1;
    min-width: 0;
  }

  .hierarchy-card {
    width: 100%;
    box-sizing: border-box;
    border-radius: var(--border-radius-1, 0.75rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    overflow: hidden;
  }

  .hierarchy-header {
    width: 100%;
    box-sizing: border-box;
    padding: 0.55rem 1rem;
    background: var(--theme-table-row-color, var(--theme-item-hover-bg));
    border-bottom: 1px solid var(--theme-divider-color);
  }

  .hierarchy-title {
    color: var(--theme-caption-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .count-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.4rem;
    border-radius: 0.4rem;
    background: var(--theme-card-bg);
    color: var(--theme-secondary-color);
    border: 1px solid var(--theme-divider-color);
    text-transform: none;
    letter-spacing: normal;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .btn-link {
    background: none;
    border: none;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    color: var(--theme-accent-color);
    cursor: pointer;
    transition: all 0.1s ease;

    &:hover:not(.disabled) {
      background: rgba(var(--theme-accent-rgb, 100, 80, 240), 0.08);
    }

    &.disabled {
      color: var(--theme-caption-color);
      cursor: default;
      opacity: 0.6;
    }
  }

  .dot-sep {
    color: var(--theme-divider-color);
    font-size: 8px;
  }

  .hierarchy-list {
    width: 100%;
    box-sizing: border-box;
    max-height: 14rem;
    overflow-y: auto;
  }

  .type-row {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 1rem;
    min-height: 2.875rem;
    border-bottom: 1px solid var(--theme-divider-color);
    cursor: pointer;
    transition: all 0.12s ease;

    &:hover {
      background: var(--theme-item-hover-bg);
    }

    &.unchecked {
      opacity: 0.5;

      .type-name {
        color: var(--theme-secondary-color);
      }
    }

    &:last-child {
      border-bottom: none;
    }
  }

  .checkbox-slot {
    display: flex;
    align-items: center;
    margin-right: 0.75rem;
    flex-shrink: 0;
  }

  .icon-slot {
    display: flex;
    align-items: center;
    margin-right: 0.625rem;
    flex-shrink: 0;
  }

  .type-name {
    color: var(--theme-content-color);
    flex-shrink: 0;
    margin-right: 0.5rem;
    transition: color 0.12s ease;
  }

  .collision-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    background: rgba(230, 160, 0, 0.12);
    color: var(--theme-warning-color, #c88a00);
    border: 1px solid rgba(230, 160, 0, 0.25);
    white-space: nowrap;
    margin-right: 0.5rem;
  }

  .relations-wrap {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 0.25rem;
    max-width: 55%;
  }

  .relation-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.55rem;
    border-radius: 0.375rem;
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    flex-shrink: 0;
  }

  .badge-role {
    font-weight: 600;
    color: var(--theme-secondary-color);
  }

  .badge-names {
    color: var(--theme-content-color);
    font-weight: 400;
  }
</style>
