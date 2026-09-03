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
  import core, { AccountRole, getCurrentAccount, type Ref } from '@hcengineering/core'
  import type { Application } from '@hcengineering/workbench'
  import { createQuery } from '@hcengineering/presentation'
  import workbench from '@hcengineering/workbench'
  import { getDefaultHiddenApps, hideApplication, isAllowedToRole, showApplication } from '../utils'
  import { Loading, IconCheck, Label, Icon, deviceOptionsStore as deviceInfo } from '@hcengineering/ui'
  import { getMetadata } from '@hcengineering/platform'
  // import Drag from './icons/Drag.svelte'

  export let apps: Application[] = []

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

  let loaded: boolean = false
  let storedHiddenIds: Array<Ref<Application>> = []
  let hiddenAppsIds: Array<Ref<Application>> = []
  const hiddenAppsIdsQuery = createQuery()
  hiddenAppsIdsQuery.query(
    workbench.class.HiddenApplication,
    {
      space: core.space.Workspace
    },
    (res) => {
      storedHiddenIds = res.map((r) => r.attachedTo)
      loaded = true
    }
  )

  // Defaults count as hidden only until the first toggle, and that toggle rewrites `storedHiddenIds`,
  // so deriving from it keeps the checkmarks in step.
  $: defaultHidden = getDefaultHiddenApps($deviceInfo.appsMini)
  $: hiddenAppsIds = [...storedHiddenIds, ...apps.filter((it) => defaultHidden.includes(it.alias)).map((it) => it._id)]

  const me = getCurrentAccount()

  // No `hiddenAppsIds` check: this list is the toggle UI, so a hidden app must stay visible here
  // with its checkmark cleared - otherwise it could never be switched back on.
  const filteredApps = apps.filter(
    (it) => isAllowedToRole(it.accessLevel, me) && it.position !== 'top' && !isExcludedApp(it.alias)
  )

  function isExcludedApp (alias: string): boolean {
    const me = getCurrentAccount()

    if (me.role === AccountRole.ReadOnlyGuest || me.role === AccountRole.Guest) {
      return (getMetadata(workbench.metadata.ExcludedApplicationsForAnonymous) ?? []).includes(alias)
    } else {
      return false
    }
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="antiPopup min-w-60" on:keydown={keyDown}>
  <div class="ap-space x2" />
  <div class="ap-scroll">
    <div class="ap-box">
      {#if loaded}
        {#each filteredApps as app, i}
          <button
            bind:this={btns[i]}
            class="ap-menuItem withIcon flex-row-center flex-grow"
            class:hover={btns[i] === activeElement}
            on:click={() => {
              if (hiddenAppsIds.includes(app._id)) showApplication(app)
              else hideApplication(app)
            }}
            on:mousemove={() => {
              focusTarget(btns[i])
            }}
          >
            <div class="icon mr-2"><Icon icon={app.icon} size={'small'} /></div>
            <span class="label overflow-label flex-grow"><Label label={app.label} /></span>
            <div class="ap-check">
              {#if !hiddenAppsIds.includes(app._id)}
                <IconCheck size={'small'} />
              {/if}
            </div>
          </button>
        {/each}
      {:else}
        <div class="ap-menuItem empty">
          <Loading />
        </div>
      {/if}
    </div>
  </div>
  <div class="ap-space x2" />
</div>
