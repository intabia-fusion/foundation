<!--
// Copyright © 2025 Hardcore Engineering Inc.
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
  import { onDestroy, onMount } from 'svelte'
  import { checkWorkspaceLimits, upgradePlan, calculateLimits, checkIsLimited, getBillingClient } from '../utils'
  import { subscriptionStore, resetSubscriptionStore } from '../stores/subscription'
  import { location, PaletteColorIndexes, Progress, tooltip } from '@hcengineering/ui'
  import { addEventListener, getMetadata, removeEventListener } from '@hcengineering/platform'
  import core, { type Tx, type TxWorkspaceEvent, WorkspaceEvent } from '@hcengineering/core'
  import presentation, { addTxListener, removeTxListener } from '@hcengineering/presentation'
  import workbench from '@hcengineering/workbench'
  import type { WorkspaceTokenWindows } from '@hcengineering/billing-client'
  import UsagePopup from './UsagePopup.svelte'

  let pollInterval: any
  let hoverInterval: any
  let windows: WorkspaceTokenWindows | undefined

  const POLL_INTERVAL_MS = 60 * 60 * 1000 // 1 hour in milliseconds
  const HOVER_POLL_INTERVAL_MS = 10 * 1000 // refresh usage every 10s while the cursor stays on the indicator

  $: state = $subscriptionStore
  $: usageInfo = state.usageInfo
  $: currentPlan = state.currentPlan
  $: currentSubscription = state.currentSubscription
  $: currentPackage = state.currentPackage
  $: currentPackageSubscription = state.currentPackageSubscription
  $: workspace = $location.path[1]

  // checkIsLimited reads the subscription store, so it must run AFTER checkWorkspaceLimits has
  // refreshed it — otherwise it sees the stale plan and misses a seat downgrade.
  const refreshLimits = async (): Promise<void> => {
    await checkWorkspaceLimits()
    await checkIsLimited()
    // Endpoint keys by workspace UUID; the URL segment is the slug, so read the resolved UUID.
    const wsUuid = getMetadata(presentation.metadata.WorkspaceUuid)
    const client = getBillingClient()
    if (wsUuid === undefined || client === null) return
    try {
      windows = await client.getWorkspaceTokenWindows(wsUuid)
    } catch (err) {
      console.error('[LimitsIndicator] token windows fetch failed', err)
    }
  }

  const connectionListener = async (): Promise<void> => {
    resetSubscriptionStore()
    if (workspace !== undefined) {
      void refreshLimits()
    }
  }

  // Server broadcasts this when usage/limit state flips; re-read so the UI is immediate.
  const txListener = (txes: Tx[]): void => {
    if (workspace === undefined) return
    for (const tx of txes) {
      if (
        tx._class === core.class.TxWorkspaceEvent &&
        (tx as TxWorkspaceEvent).event === WorkspaceEvent.LimitsChanged
      ) {
        void refreshLimits()
        return
      }
    }
  }

  // Calculate usage percentages from store data
  $: storageUsed = usageInfo?.usage?.storageBytes ?? 0
  $: limits = calculateLimits(currentPlan, currentPackage, currentSubscription, currentPackageSubscription)

  function barColor (used: number, limit: number): PaletteColorIndexes | undefined {
    if (limit <= 0) return undefined
    const ratio = used / limit
    if (ratio >= 1) return PaletteColorIndexes.Firework
    if (ratio >= 0.75) return PaletteColorIndexes.Sunshine
    return PaletteColorIndexes.Grass
  }

  $: storageColor = barColor(storageUsed, limits?.storageLimit ?? 0)
  // Bought tokens are spent first, so the bar counts them in: against the tier limit alone a
  // workspace with a balance looked exhausted.
  $: monthTotal = windows === undefined || windows.month.limit === 0 ? 0 : windows.month.limit + windows.balance
  $: tokenMonthColor = windows !== undefined ? barColor(windows.month.used, monthTotal) : undefined

  onMount(() => {
    addEventListener(workbench.event.NotifyConnection, connectionListener)
    addTxListener(txListener)

    // Initial check if workspace exists
    if (workspace != null) {
      void refreshLimits()

      pollInterval = setInterval(() => {
        void refreshLimits()
      }, POLL_INTERVAL_MS)
    }
  })

  onDestroy(() => {
    if (pollInterval !== undefined) {
      clearInterval(pollInterval)
    }
    if (hoverInterval !== undefined) {
      clearInterval(hoverInterval)
    }
    removeEventListener(workbench.event.NotifyConnection, connectionListener)
    removeTxListener(txListener)
  })

  function handleClick (): void {
    void upgradePlan()
  }

  // Live usage isn't broadcast; refresh on hover and keep polling while the cursor is on the indicator.
  function handleHoverStart (): void {
    if (workspace == null || hoverInterval !== undefined) return
    void refreshLimits()
    hoverInterval = setInterval(() => {
      void refreshLimits()
    }, HOVER_POLL_INTERVAL_MS)
  }

  function handleHoverEnd (): void {
    if (hoverInterval !== undefined) {
      clearInterval(hoverInterval)
      hoverInterval = undefined
    }
  }
</script>

<button
  type="button"
  class="limits-container"
  data-id="billingLimitsIndicator"
  use:tooltip={{
    component: UsagePopup,
    props: {
      usage: usageInfo,
      plan: currentPlan,
      tierSub: currentSubscription,
      pkg: currentPackage,
      pkgSub: currentPackageSubscription,
      windows
    },
    direction: 'bottom'
  }}
  on:click={handleClick}
  on:mouseenter={handleHoverStart}
  on:mouseleave={handleHoverEnd}
>
  <div class="progress-wrapper">
    <Progress color={storageColor} value={storageUsed} max={limits?.storageLimit ?? 0} fallback={0} />
  </div>
  <div class="progress-wrapper">
    <Progress color={tokenMonthColor} value={windows?.month.used ?? 0} max={monthTotal} fallback={0} />
  </div>
</button>

<style lang="scss">
  .limits-container {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    border-radius: var(--extra-small-BorderRadius);
    cursor: pointer;
    transition: background-color 0.2s ease;
    padding: 0.188rem;
    width: 1.75rem;
    border: 1px solid var(--theme-trans-color);
    background: none;
    outline: none;

    &:hover,
    &:focus {
      background-color: var(--theme-button-hovered);
    }
  }

  .progress-wrapper {
    width: 100%;
  }
</style>
