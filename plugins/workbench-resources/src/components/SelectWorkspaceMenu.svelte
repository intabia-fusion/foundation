<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { isArchivingMode, systemAccountUuid, WorkspaceInfoWithStatus } from '@hcengineering/core'
  import login from '@hcengineering/login'
  import { getResource } from '@hcengineering/platform'
  import presentation, {
    canLeaveWorkspace,
    createQuery,
    hasResource,
    getCurrentWorkspaceUuid
  } from '@hcengineering/presentation'
  import {
    closePopup,
    getCurrentLocation,
    IconCheck,
    isSameSegments,
    Label,
    Loading,
    Location,
    locationStorageKeyId,
    locationToUrl,
    navigate,
    resolvedLocationStore,
    SearchEdit
  } from '@hcengineering/ui'
  import { workbenchId } from '@hcengineering/workbench'
  import { onMount } from 'svelte'
  import type { PersonRating } from '@hcengineering/rating'
  import ratingPlugin from '@hcengineering/rating'

  import { workspacesStore } from '../utils'
  import { crossWorkspaceNotificationStore } from '../workbench'
  // import Drag from './icons/Drag.svelte'

  onMount(() => {
    void getResource(login.function.GetWorkspaces).then(async (f) => {
      $workspacesStore = await f()
    })
  })

  const currentWorkspaceUuid = getCurrentWorkspaceUuid()

  const levelQuery = createQuery()

  let sysRating: PersonRating | undefined

  levelQuery.query(ratingPlugin.class.PersonRating, { accountId: systemAccountUuid }, (res) => {
    sysRating = res[0]
  })

  const hasRating = hasResource(ratingPlugin.component.RatingRing)

  function getWorkspaceLink (ws: WorkspaceInfoWithStatus): string {
    const loc: Location = {
      path: [workbenchId, ws.url]
    }
    return locationToUrl(loc)
  }

  async function clickHandler (e: MouseEvent, wsUrl: string): Promise<void> {
    if (!e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      const current = getCurrentLocation()
      if (wsUrl !== current.path[1]) {
        if (!(await canLeaveWorkspace())) return
      }
      closePopup()
      closePopup()
      if (wsUrl !== current.path[1]) {
        let last: Location | undefined
        try {
          last = JSON.parse(localStorage.getItem(`${locationStorageKeyId}_${wsUrl}`) ?? '')
        } catch (err: any) {
          // Ignore
        }
        if (last != null && isSameSegments(last, current, 2)) {
          navigate(last)
        } else {
          navigate({ path: [workbenchId, wsUrl] })
        }
      }
    }
  }

  let activeElement: HTMLElement
  const btns: HTMLElement[] = []

  function focusTarget (target: HTMLElement): void {
    activeElement = target
  }

  const keyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Tab') {
      ev.preventDefault()
      ev.stopPropagation()
    }
    const n = btns.indexOf(activeElement) ?? 0
    if (ev.key === 'ArrowDown') {
      if (n < btns.length - 1) {
        activeElement = btns[n + 1]
      }
      ev.preventDefault()
      ev.stopPropagation()
    }
    if (ev.key === 'ArrowUp') {
      if (n > 0) {
        activeElement = btns[n - 1]
      }
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

  let search: string = ''

  $: workspacesNotification = $crossWorkspaceNotificationStore

  $: sortedWorkspaces = $workspacesStore
    .filter((it) => search === '' || (it.name?.includes(search) ?? false) || it.url.includes(search))
    .sort((a, b) => {
      if (a.uuid === currentWorkspaceUuid) return -1
      if (b.uuid === currentWorkspaceUuid) return 1
      const aName = (a.name ?? a.url).toLowerCase()
      const bName = (b.name ?? b.url).toLowerCase()
      return aName.localeCompare(bName)
    })
    .slice(0, 500)
</script>

{#if $workspacesStore.length}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="antiPopup" on:keydown={keyDown}>
    <div class="ap-space x2" />

    <!--    <div class="p-2 ml-2 mr-2 mb-2 flex-grow flex flex-col">-->
    <!--      <div class="text-lg font-bold">-->
    <!--        {getMetadata(presentation.metadata.WorkspaceName) ?? ''}-->
    <!--      </div>-->
    <!--      {#if hasRating}-->
    <!--        <div class="flex-row-center text-sm">-->
    <!--          <Component-->
    <!--            is={ratingPlugin.component.RatingRing}-->
    <!--            props={{ rating: sysRating?.rating ?? 0, showValues: true }}-->
    <!--          />-->
    <!--        </div>-->
    <!--        <div class="flex-row-center mt-2">-->
    <!--          <Component is={ratingPlugin.component.RatingActivities} props={{ rating: sysRating }} />-->
    <!--        </div>-->
    <!--      {/if}-->
    <!--    </div>-->

    {#if $workspacesStore.length > 8}
      <div class="p-2 ml-2 mr-2 mb-2 flex-grow flex-row-center">
        <SearchEdit bind:value={search} width={'100%'} />
      </div>
    {/if}
    <div class="ap-scroll">
      <div class="ap-box">
        {#each sortedWorkspaces as ws, i}
          {@const wsName = ws.name ?? ws.url}
          <a
            class="stealth"
            href={getWorkspaceLink(ws)}
            on:click={async (e) => {
              await clickHandler(e, ws.url)
            }}
          >
            <button
              bind:this={btns[i]}
              class="ap-menuItem flex-row-center flex-grow"
              class:hover={btns[i] === activeElement}
              on:mousemove={() => {
                focusTarget(btns[i])
              }}
            >
              <!-- <div class="drag"><Drag size={'small'} /></div> -->
              <!-- <div class="logo empty" /> -->
              <!-- <div class="flex-col flex-grow"> -->
              <div class="flex-col flex-grow">
                <div class="flex-presenter flex-gap-2">
                  <span class="label overflow-label flex flex-grow flex-between">
                    {wsName}
                    {#if isArchivingMode(ws.mode)}
                      - <Label label={presentation.string.Archived} />
                    {/if}
                  </span>
                </div>
              </div>
              <!-- <span class="description overflow-label">Description</span> -->
              <!-- </div> -->
              <div class="ap-check">
                {#if $resolvedLocationStore.path[1] === ws.url}
                  <IconCheck size={'small'} />
                {/if}
              </div>
              {#if workspacesNotification?.[ws.uuid] === true && ws.uuid !== currentWorkspaceUuid}
                <div class="notification-container">
                  <span class="notification" />
                </div>
              {/if}
            </button>
          </a>
        {/each}
      </div>
    </div>
    <div class="ap-space x2" />
  </div>
{:else}
  <div class="antiPopup"><Loading /></div>
{/if}

<style lang="scss">
  .active {
    background-color: var(--theme-inbox-people-counter-bgcolor);
  }

  .logo {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    &.empty {
      background-color: var(--theme-sidebar-hover-bgcolor);
    }
  }

  .notification-container {
    width: 1rem;
    height: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .notification {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background-color: var(--global-higlight-Color);
  }
</style>
