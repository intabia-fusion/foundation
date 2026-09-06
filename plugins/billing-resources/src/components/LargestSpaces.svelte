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
  import core, { type Ref, type Space, getCurrentAccount } from '@hcengineering/core'
  import { getCurrentWorkspaceUuid, getClient, createQuery } from '@hcengineering/presentation'
  import { Button, Expandable, Loading, Scroller } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { filesize } from 'filesize'
  import { getBillingClient } from '../utils'
  import type { LargestSpaceInfo } from '@hcengineering/billing-client'
  import LargestFiles from './LargestFiles.svelte'
  import { ObjectPresenter } from '@hcengineering/view-resources'

  interface SpaceSizeInfo {
    space: Space
    size: number
    isMember: boolean
  }

  let spaces: SpaceSizeInfo[] = []
  let loading = true

  const billingClient = getBillingClient()
  const client = getClient()
  const myAcc = getCurrentAccount()

  let spaceIds: Ref<Space>[] = []

  const spaceQuery = createQuery()

  let spaceDocs: Space[] = []

  $: {
    spaceQuery.query(
      core.class.Space,
      { _id: { $in: spaceIds } },
      (res) => {
        spaceDocs = res
      },
      { showArchived: true }
    )
  }
  let info: LargestSpaceInfo[] = []
  $: {
    const spaceMap = new Map<Ref<Space>, Space>()
    spaceDocs.forEach((space: Space) => {
      spaceMap.set(space._id, space)
    })

    spaces = info
      .map((item: LargestSpaceInfo) => {
        const space = spaceMap.get(item.spaceId as Ref<Space>)
        const isMember = space?.members?.includes(myAcc.uuid) ?? false
        return {
          space,
          size: item.size,
          isMember
        }
      })
      .filter((it) => it.space != null) as SpaceSizeInfo[]
  }

  async function loadLargestSpaces (): Promise<void> {
    if (billingClient == null) {
      loading = false
      return
    }

    loading = true
    try {
      info = await billingClient.getLargestSpaces(getCurrentWorkspaceUuid())

      if (info != null && Array.isArray(info)) {
        spaceIds = info.map((item: LargestSpaceInfo) => item.spaceId as Ref<Space>)
      } else {
        spaceIds = []
      }
    } catch (err) {
      console.error('Failed to load largest spaces:', err)
      spaceIds = []
    } finally {
      loading = false
    }
  }

  async function joinSpace (space: Space): Promise<void> {
    if (space.members?.includes(myAcc.uuid)) return

    const newMembers = [...(space.members ?? []), myAcc.uuid]
    await client.update(space, { members: newMembers })
  }

  void loadLargestSpaces()
</script>

{#if loading}
  <Loading />
{:else if spaces.length > 0}
  <Scroller align={'start'} padding={'var(--spacing-2)'} bottomPadding={'var(--spacing-2)'}>
    <div class="hulyComponent-content">
      {#each spaces as spaceInfo, i}
        {@const expnd = spaceInfo.isMember || !spaceInfo.space.private}
        <Expandable expandable={expnd} showChevron={expnd} bordered contentColor>
          <svelte:fragment slot="title">
            <div class="flex-row-center text-base">
              <span class="space-index">{i + 1}.</span>
              <span class="space-name">
                <ObjectPresenter
                  _class={spaceInfo.space._class}
                  value={spaceInfo.space}
                  objectId={spaceInfo.space._id}
                />
              </span>
            </div>
          </svelte:fragment>
          <svelte:fragment slot="tools">
            <span class="space-size">{filesize(spaceInfo.size, { spacer: ' ' })}</span>

            {#if !expnd}
              <Button
                label={view.string.Join}
                kind="primary"
                size="small"
                on:click={() => joinSpace(spaceInfo.space)}
              />
            {/if}
          </svelte:fragment>
          <LargestFiles
            space={spaceInfo.space._id}
            on:delete={(evt) => {
              spaceInfo.size -= evt.detail
            }}
          />
        </Expandable>
      {/each}
    </div>
  </Scroller>
{/if}

<style lang="scss">
  .space-index {
    color: var(--theme-halfcontent-color);
    font-size: 0.8125rem;
    min-width: 1.5rem;
  }

  .space-name {
    flex: 1;
    color: var(--theme-caption-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 20rem;
  }

  .space-size {
    font-weight: 500;
    color: var(--theme-caption-color);
    white-space: nowrap;
    min-width: 4rem;
    text-align: right;
  }

  .space-files {
    margin-left: 1.5rem;
    margin-top: 0.25rem;
  }
</style>
