<!--
// Copyright © 2026 Intabia Fusion
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
  import { onMount } from 'svelte'
  import type { WorkspaceUuid } from '@hcengineering/core'
  import type { WorkspaceTokenWindows } from '@hcengineering/billing-client'
  import { Button, DropdownLabels, EditBox, Label, type DropdownTextItem } from '@hcengineering/ui'
  import plugin from '@hcengineering/billing'
  import { getBillingClient } from '../utils'
  import TokenWindows from './TokenWindows.svelte'

  export let workspace: WorkspaceUuid

  let windows: WorkspaceTokenWindows | undefined
  let usedValue = 0
  let level = 'low'
  let levelItems: DropdownTextItem[] = [{ id: 'low', label: 'low' }]
  let busy = false

  async function reload (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    try {
      windows = await client.getWorkspaceTokenWindows(workspace)
      const registry = await client.listAiModelRegistry()
      const levels = [...new Set(registry.map((r) => r.level).filter((l) => l !== ''))]
      if (levels.length > 0) levelItems = levels.map((l) => ({ id: l, label: l }))
    } catch (err) {
      console.error('Failed to load workspace token windows:', err)
    }
  }

  async function reset (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    busy = true
    try {
      await client.resetWorkspaceUsed(workspace)
      await reload()
    } finally {
      busy = false
    }
  }

  async function setUsed (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    busy = true
    try {
      await client.setWorkspaceUsed(workspace, Math.max(0, Math.floor(usedValue)), level)
      await reload()
    } finally {
      busy = false
    }
  }

  onMount(reload)
</script>

<TokenWindows {windows} />

<div class="flex-row-center flex-gap-2 mt-2">
  <div style:width="8rem">
    <EditBox bind:value={usedValue} format="number" placeholder={plugin.string.SetLimit} />
  </div>
  <DropdownLabels
    items={levelItems}
    bind:selected={level}
    kind="regular"
    size="medium"
    label={plugin.string.PickModel}
  />
  <Button label={plugin.string.SetLimit} kind="regular" disabled={busy} on:click={setUsed} />
  <Button label={plugin.string.ResetUsed} kind="ghost" disabled={busy} on:click={reset} />
</div>
