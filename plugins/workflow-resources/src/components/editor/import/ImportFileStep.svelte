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
  import { createEventDispatcher, onMount } from 'svelte'
  import { translateCB } from '@hcengineering/platform'
  import task from '@hcengineering/task'
  import { Icon, IconCheck, IconError, Label, themeStore } from '@hcengineering/ui'
  import type { WorkflowConfig } from '@hcengineering/workflow'

  import plugin from '../../../plugin'
  import { parseWorkflowConfig } from './utils'

  export let config: WorkflowConfig | null = null
  export let workflowName: string = ''
  export let initialText: string = ''
  export let initialFileName: string = ''
  export let isSaving: boolean = false
  export let rawJsonText: string = initialText
  export let hasText: boolean = initialText.trim().length > 0

  const dispatch = createEventDispatcher<{
    loaded: { config: WorkflowConfig, workflowName: string }
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    reset: void
  }>()

  let selectedFileName = initialFileName
  let parseError: string | null = initialText.trim().length > 0 && config == null ? 'InvalidFormat' : null

  $: hasText = rawJsonText.trim().length > 0

  let textAreaEl: HTMLTextAreaElement | undefined
  let fileInput: HTMLInputElement | undefined
  let placeholderText = ''

  $: translateCB(plugin.string.PasteJsonPlaceholder, {}, $themeStore.language, (res) => {
    placeholderText = res
  })

  onMount(() => {
    if (initialText.trim().length > 0 && config == null) {
      void processJsonText(initialText, initialFileName !== '' ? initialFileName : 'Clipboard')
    } else if (config == null && textAreaEl !== undefined) {
      textAreaEl.focus()
      textAreaEl.scrollTop = 0
      textAreaEl.setSelectionRange(0, 0)
    }
  })

  export function tryCommit (): boolean {
    if (config != null) return true
    if (rawJsonText.trim().length === 0) {
      parseError = 'InvalidFormat'
      return false
    }
    return processJsonText(rawJsonText, 'Clipboard')
  }

  function processJsonText (text: string, sourceName: string): boolean {
    const result = parseWorkflowConfig(text, sourceName)
    if (!result.ok) {
      parseError = result.error
      config = null
      return false
    }

    config = result.config
    parseError = null
    selectedFileName = sourceName
    workflowName = result.workflowName
    dispatch('loaded', { config: result.config, workflowName: result.workflowName })
    return true
  }

  function resetFileSelection (): void {
    config = null
    parseError = null
    selectedFileName = ''
    rawJsonText = ''
    if (fileInput !== undefined) {
      fileInput.value = ''
    }
    dispatch('reset')
    setTimeout(() => {
      if (textAreaEl !== undefined) {
        textAreaEl.focus()
        textAreaEl.scrollTop = 0
        textAreaEl.setSelectionRange(0, 0)
      }
    }, 0)
  }

  function handleWindowPaste (event: ClipboardEvent): void {
    if (config != null || isSaving) return
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

  async function handleFileChange (event: Event): Promise<void> {
    const target = event.target as HTMLInputElement
    const files = target.files
    if (files == null || files.length === 0) return
    const file = files[0]
    try {
      const text = await file.text()
      processJsonText(text, file.name)
    } catch {
      parseError = 'InvalidFormat'
    }
  }
</script>

<svelte:window on:paste={handleWindowPaste} />

<div class="file-step-container">
  <input type="file" accept=".json" bind:this={fileInput} style="display: none;" on:change={handleFileChange} />

  {#if config == null}
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
              {:else if parseError === 'InvalidWorkflowFile'}
                <Label label={plugin.string.InvalidWorkflowFile} />
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
    <div class="file-selected-card flex-between flex-row-center">
      <div class="flex-row-center flex-gap-2">
        <div class="success-icon flex-center">
          <IconCheck size="small" />
        </div>
        <div class="file-meta flex-col">
          <span class="font-medium-14">
            {#if selectedFileName === 'Clipboard'}
              <Label label={plugin.string.ClipboardSource} />
            {:else}
              {selectedFileName}
            {/if}
          </span>
          <span class="font-regular-12 text-secondary">{workflowName}</span>
        </div>
      </div>
      <button type="button" class="change-file-btn font-medium-12" on:click={resetFileSelection}>
        <Label label={plugin.string.ChangeFile} />
      </button>
    </div>
  {/if}
</div>

<style lang="scss">
  .file-step-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    flex: 1;
    min-height: 26rem;
    box-sizing: border-box;
  }

  .json-input-card {
    width: 100%;
    height: 100%;
    flex: 1;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .textarea-wrapper {
    width: 100%;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 22rem;
    border-radius: var(--border-radius-1, 0.5rem);
    border: 1px solid var(--theme-divider-color);
    background: var(--theme-card-bg);
    padding: 0.75rem 0.875rem;
    box-sizing: border-box;
  }

  .json-textarea {
    width: 100%;
    height: 100%;
    flex: 1;
    min-height: 20rem;
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

  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--border-radius-1, 0.5rem);
    background-color: rgba(218, 54, 51, 0.08);
    border: 1px solid rgba(218, 54, 51, 0.25);
    color: #da3633;
    box-sizing: border-box;
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
    padding: var(--spacing-3);
    border-radius: var(--border-radius-md, 0.375rem);
    background-color: var(--theme-card-background, rgba(0, 0, 0, 0.02));
    border: 1px solid var(--theme-divider-color, rgba(0, 0, 0, 0.08));
    box-sizing: border-box;
  }

  .success-icon {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background-color: rgba(46, 160, 67, 0.15);
    color: #2ea043;
  }

  .file-meta {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .change-file-btn {
    border: none;
    background: transparent;
    color: var(--primary-button-background, #6452db);
    cursor: pointer;
    padding: 0.25rem 0.5rem;

    &:hover {
      text-decoration: underline;
    }
  }
</style>
