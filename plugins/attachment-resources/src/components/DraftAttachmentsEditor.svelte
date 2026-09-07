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
  import { onDestroy } from 'svelte'
  import attachment, { Attachment, AttachmentValue, DraftAttachment } from '@hcengineering/attachment'
  import { Blob, Class, Doc, Ref, Space } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import { createQuery, deleteFile, getClient, uploadFile } from '@hcengineering/presentation'
  import { Icon, IconAdd, IconClose, Label, Spinner } from '@hcengineering/ui'
  import { filesize } from 'filesize'

  import { createAttachment, openAttachmentInSidebar, showAttachmentPreviewPopup, savedBlobs } from '../utils'
  import IconAttachments from './icons/Attachments.svelte'

  export let object: Doc | undefined = undefined
  export let objectId: Ref<Doc> = object?._id as Ref<Doc>
  export let space: Ref<Space> = object?.space as Ref<Space>
  export let _class: Ref<Class<Doc>> = object?._class as Ref<Class<Doc>>
  export let readonly: boolean = false
  export let label: IntlString = attachment.string.Attachments
  export let draft: boolean = false
  export let includeExistingInDraft: boolean = false
  export let value: AttachmentValue[] | undefined = undefined
  export let onChange: (value: AttachmentValue[]) => void = () => {}

  const client = getClient()
  const uploadedBlobs = new Set<Ref<Blob>>()

  let inputFile: HTMLInputElement
  let loading = false
  let isDragging = false
  let dbItems: Attachment[] = []

  const query = createQuery()

  $: targetId = objectId ?? object?._id
  $: if (targetId != null && (includeExistingInDraft || !draft)) {
    query.query(attachment.class.Attachment, { attachedTo: targetId }, (result) => {
      dbItems = result
    })
  }

  $: items = draft ? (Array.isArray(value) ? value : includeExistingInDraft ? dbItems : []) : dbItems

  function notifyChange (newVal: AttachmentValue[]): void {
    value = newVal
    onChange(value)
  }

  async function removeItem (item: AttachmentValue, index: number): Promise<void> {
    if (readonly) return
    if (draft) {
      const fileId = (typeof item === 'string' ? item : item?.file) as Ref<Blob>
      if (fileId != null && uploadedBlobs.has(fileId)) {
        uploadedBlobs.delete(fileId)
        savedBlobs.delete(fileId)
        void deleteFile(fileId)
      }
      const next = [...items]
      next.splice(index, 1)
      notifyChange(next)
    } else {
      if (typeof item === 'object' && '_id' in item && item._id) {
        await client.remove(item as Attachment)
      }
    }
  }

  onDestroy(() => {
    if (draft) {
      for (const fileId of uploadedBlobs) {
        if (!savedBlobs.has(fileId)) {
          void deleteFile(fileId)
        }
      }
    }
  })

  async function openPreview (item: AttachmentValue): Promise<void> {
    if (item == null) return
    const blobObj =
      typeof item === 'string'
        ? { file: item, name: 'Attachment', type: '', size: 0 }
        : {
            _id: '_id' in item ? item._id : undefined,
            file: item.file,
            name: item.name ?? 'Attachment',
            type: item.type ?? '',
            size: item.size ?? 0,
            metadata: 'metadata' in item ? item.metadata : undefined
          }

    const contentType = blobObj.type ?? ''
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === ''
    ) {
      showAttachmentPreviewPopup(blobObj as any)
    } else {
      try {
        await openAttachmentInSidebar(blobObj as any)
      } catch (err) {
        showAttachmentPreviewPopup(blobObj as any)
      }
    }
  }

  function openFile (): void {
    if (readonly) return
    inputFile?.click()
  }

  function handleDragOver (e: DragEvent): void {
    if (readonly) return
    e.preventDefault()
    e.stopPropagation()
    isDragging = true
  }

  function handleDragLeave (e: DragEvent): void {
    if (readonly) return
    e.preventDefault()
    e.stopPropagation()
    isDragging = false
  }

  async function handleDrop (e: DragEvent): Promise<void> {
    if (readonly) return
    e.preventDefault()
    e.stopPropagation()
    isDragging = false

    const files = e.dataTransfer?.files
    if (files == null || files.length === 0) return

    await processFileList(files)
  }

  async function processFileList (list: FileList | File[]): Promise<void> {
    loading = true
    try {
      if (draft) {
        const newItems: AttachmentValue[] = [...items]
        for (let i = 0; i < list.length; i++) {
          const file = list[i]
          const { uuid } = await uploadFile(file)
          uploadedBlobs.add(uuid)
          const draftAtt: DraftAttachment = {
            name: file.name,
            file: uuid,
            size: file.size,
            type: file.type
          }
          newItems.push(draftAtt)
        }
        notifyChange(newItems)
      } else {
        for (let i = 0; i < list.length; i++) {
          const file = list[i]
          const { uuid, metadata } = await uploadFile(file)
          await createAttachment(
            client,
            uuid,
            file.name,
            file,
            metadata,
            { objectClass: object?._class ?? _class, objectId: objectId ?? object?._id, space: space ?? object?.space },
            attachment.class.Attachment,
            {}
          )
        }
      }
    } finally {
      loading = false
      if (inputFile) inputFile.value = ''
    }
  }

  async function fileSelected (): Promise<void> {
    const list = inputFile?.files
    if (list == null || list.length === 0) return
    await processFileList(list)
  }

  function getItemName (item: AttachmentValue): string {
    if (typeof item === 'string') return item
    return item.name ?? 'Attachment'
  }

  function getItemSize (item: AttachmentValue): number | undefined {
    if (typeof item === 'object' && item != null && 'size' in item) {
      return item.size
    }
    return undefined
  }
</script>

<input type="file" multiple style="display: none" bind:this={inputFile} on:change={fileSelected} />

<div class="attachments-editor">
  {#if items.length > 0}
    <div class="attachments-editor--badges">
      {#each items as item, index}
        {@const name = getItemName(item)}
        {@const size = getItemSize(item)}
        <div
          role="button"
          tabindex="0"
          class="attachments-editor--badge"
          on:click|stopPropagation={() => openPreview(item)}
          on:keydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openPreview(item)
            }
          }}
        >
          <Icon icon={IconAttachments} size="x-small" />
          <span class="attachments-editor--badge-name overflow-label">{name}</span>
          {#if size}
            <span class="attachments-editor--badge-size">{filesize(size)}</span>
          {/if}
          {#if !readonly}
            <button
              type="button"
              class="attachments-editor--btn-close"
              on:click|stopPropagation={() => removeItem(item, index)}
            >
              <Icon icon={IconClose} size="x-small" />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if !readonly}
    <div
      role="button"
      tabindex="0"
      class="attachments-editor--dropzone"
      class:is-dragging={isDragging}
      on:click|stopPropagation={openFile}
      on:keydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openFile()
        }
      }}
      on:dragover={handleDragOver}
      on:dragenter={handleDragOver}
      on:dragleave={handleDragLeave}
      on:drop={handleDrop}
    >
      {#if loading}
        <Spinner size="small" />
      {:else}
        <Icon icon={IconAdd} size="small" />
        <span class="attachments-editor--dropzone-text">
          <Label {label} />
        </span>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .attachments-editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;

    &--badges {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: wrap;
      gap: 0.375rem;
      width: 100%;
    }

    &--badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.5rem;
      height: 1.75rem;
      background: var(--global-subtle-ui-BackgroundColor);
      border: 1px solid var(--global-subtle-ui-BorderColor);
      border-radius: 1rem;
      font-size: 0.8125rem;
      color: var(--global-primary-TextColor);
      cursor: pointer;

      &-name {
        max-width: 10rem;
      }

      &-size {
        font-size: 0.6875rem;
        color: var(--global-secondary-TextColor);
      }
    }

    &--btn-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.125rem;
      height: 1.125rem;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      cursor: pointer;
      color: var(--global-secondary-TextColor);
      transition: all 0.15s ease-in-out;

      &:hover {
        color: var(--global-negative-TextColor, #ef4444);
        background: var(--global-negative-BackgroundColor, rgba(239, 68, 68, 0.15));
      }
    }

    &--dropzone {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      height: 2.75rem;
      padding: 0.375rem 0.75rem;
      background: var(--global-subtle-ui-BackgroundColor);
      border: 1px dashed var(--global-subtle-ui-BorderColor);
      border-radius: var(--medium-BorderRadius);
      font-size: 0.8125rem;
      color: var(--global-secondary-TextColor);
      cursor: pointer;
      transition: all 0.15s ease-in-out;

      &:hover,
      &.is-dragging {
        color: var(--global-primary-TextColor);
        border-color: var(--global-focus-BorderColor);
        background: var(--global-ui-highlight-BackgroundColor);
      }

      &-text {
        font-size: 0.8125rem;
        user-select: none;
      }
    }
  }
</style>
