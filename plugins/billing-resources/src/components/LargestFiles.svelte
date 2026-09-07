<!--
// Copyright © 2026 Intabia Fusion.
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
  import { SortingOrder, type Ref, type Space } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import attachment, { type Attachment } from '@hcengineering/attachment'
  import { Button, IconDelete, Loading, showPopup } from '@hcengineering/ui'
  import { filesize } from 'filesize'
  import { deleteObjects, FixedColumn, ObjectPresenter } from '@hcengineering/view-resources'
  import contact from '@hcengineering/contact'
  import { createEventDispatcher } from 'svelte'

  export let space: Ref<Space> | undefined = undefined

  const limit = 20

  let files: Attachment[] = []
  let loading = true

  const attachmentQuery = createQuery()

  $: attachmentQuery.query(
    attachment.class.Attachment,
    space != null ? { space } : {},
    (res) => {
      files = res
      loading = false
    },
    {
      sort: { size: SortingOrder.Descending },
      limit
    }
  )
  const h = getClient().getHierarchy()
  const dispatch = createEventDispatcher()
</script>

{#if loading}
  <Loading />
{:else if files.length > 0}
  <div class="files-list">
    {#each files as file, i}
      <div class="file-row flex flex-between">
        <span class="file-index">{i + 1}.</span>
        <div class="flex flex-row-center flex-grow">
          <FixedColumn key={'file-link'}>
            <ObjectPresenter _class={file._class} value={file} objectId={file._id} inline props={{ showSize: false }} />
          </FixedColumn>
          <div class="file-type">
            <FixedColumn key={'source-link'}>
              <ObjectPresenter
                _class={file.attachedToClass}
                objectId={file.attachedTo}
                inline
                props={{ kind: 'list' }}
              />
            </FixedColumn>
          </div>
        </div>
        <span class="file-size">{filesize(file.size, { spacer: ' ' })}</span>
        <Button
          icon={IconDelete}
          on:click={() => {
            showPopup(
              contact.component.DeleteConfirmationPopup,
              {
                object: file,
                skipCheck: true,
                confirmation: undefined,
                deleteAction: async () => {
                  try {
                    await deleteObjects(getClient(), [file], true)
                    dispatch('delete', file.size)
                  } catch (e) {
                    console.error(e)
                  }
                }
              },
              undefined
            )
          }}
        />
      </div>
    {/each}
  </div>
{/if}

<style lang="scss">
  .files-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    background-color: var(--theme-button-default);

    &:hover {
      background-color: var(--theme-button-hovered);
    }
  }

  .file-index {
    color: var(--theme-halfcontent-color);
    font-size: 0.8125rem;
    min-width: 1.5rem;
  }

  .file-name {
    flex: 1;
    font-size: 0.8125rem;
    color: var(--theme-caption-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 15rem;
    max-width: 20rem;
  }

  .file-type {
    font-size: 0.75rem;
    color: var(--theme-halfcontent-color);
    white-space: nowrap;
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-size {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--theme-caption-color);
    white-space: nowrap;
    min-width: 4rem;
    text-align: right;
  }
</style>
