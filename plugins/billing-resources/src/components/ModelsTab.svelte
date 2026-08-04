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
  import { onDestroy, onMount } from 'svelte'
  import { Button, EditBox, Label, Loading, Progress } from '@hcengineering/ui'
  import type { AiModelRegistryEntry, AiTranscriptBreakdown, ProviderPool } from '@hcengineering/billing-client'
  import { getBillingClient } from '../utils'
  import plugin from '../plugin'
  import { pct, barColor, formatMinutes } from '../billingFormat'

  // aibot pushes the registry and pool usage lazily (on spend), so poll instead of a one-shot load —
  // otherwise a model first used after this tab opened stays missing until a manual refresh.
  const POLL_INTERVAL_MS = 5 * 60 * 1000
  let pollInterval: ReturnType<typeof setInterval> | undefined

  let loading = true
  let registry: AiModelRegistryEntry[] = []
  let pools: ProviderPool[] = []
  let asrByModel: AiTranscriptBreakdown[] = []
  const topup: Record<string, number> = {}
  const newLimit: Record<string, number> = {}

  function poolKey (providerId: string, model: string): string {
    return `${providerId} ${model}`
  }

  async function reloadPools (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    pools = await client.listProviderPools()
  }

  async function refresh (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    ;[registry, pools, asrByModel] = await Promise.all([
      client.listAiModelRegistry(),
      client.listProviderPools(),
      client.getTranscriptUsage('level')
    ])
  }

  async function addTokens (providerId: string, model: string): Promise<void> {
    const key = poolKey(providerId, model)
    const delta = topup[key]
    if (delta === undefined || delta <= 0) return
    const client = getBillingClient()
    if (client === null) return
    await client.addProviderPoolTokens(providerId, model, delta)
    topup[key] = 0
    await reloadPools()
  }

  async function setLimit (providerId: string, model: string): Promise<void> {
    const key = poolKey(providerId, model)
    const tokens = newLimit[key]
    if (tokens === undefined || tokens <= 0) return
    const client = getBillingClient()
    if (client === null) return
    await client.upsertProviderPool({
      providerId,
      model,
      kind: 'purchased',
      purchasedTokens: tokens,
      period: 'monthly'
    })
    newLimit[key] = 0
    await reloadPools()
  }

  async function resetUsed (providerId: string, model: string): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    await client.resetPoolUsed(providerId, model)
    await reloadPools()
  }

  async function resetAllUsed (): Promise<void> {
    const client = getBillingClient()
    if (client === null) return
    await client.resetPoolUsed(undefined, undefined, true)
    await reloadPools()
  }

  $: poolMap = new Map(pools.map((p) => [poolKey(p.providerId, p.model), p]))

  onMount(async () => {
    if (getBillingClient() === null) {
      loading = false
      return
    }
    try {
      await refresh()
    } finally {
      loading = false
    }
    pollInterval = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
  })

  onDestroy(() => {
    if (pollInterval !== undefined) clearInterval(pollInterval)
  })
</script>

{#if loading}
  <Loading />
{:else}
  <div class="flex-col flex-gap-4 p-6">
    <div class="flex-between">
      <span class="fs-title"><Label label={plugin.string.ModelLimits} /></span>
      <Button label={plugin.string.ResetAllUsed} kind="ghost" on:click={resetAllUsed} />
    </div>
    <div class="flex-col flex-gap-2">
      {#each registry as entry (poolKey(entry.providerId, entry.model))}
        {@const key = poolKey(entry.providerId, entry.model)}
        {@const pool = poolMap.get(key)}
        {@const usedPct = pool !== undefined ? pct(pool.usedTokens, pool.purchasedTokens) : 0}
        <div class="model-card flex-row-center flex-gap-3">
          <span class="model-name flex-row-center flex-gap-2">
            <span class="font-medium">{entry.providerId} / {entry.model}</span>
            <span class="content-dark-color text-sm">{entry.level}</span>
          </span>
          {#if pool !== undefined}
            <span class="text-sm text-right no-word-wrap">
              {pool.usedTokens.toLocaleString('en-US')} / {pool.purchasedTokens.toLocaleString('en-US')}
            </span>
            <span class="model-bar"
              ><Progress value={usedPct} max={100} color={barColor(usedPct)} fallback={100} /></span
            >
            <EditBox kind="default" format="number" bind:value={topup[key]} placeholder={plugin.string.AddTokens} />
            <Button
              label={plugin.string.AddTokens}
              kind="regular"
              on:click={() => addTokens(entry.providerId, entry.model)}
            />
            <Button
              label={plugin.string.ResetUsed}
              kind="ghost"
              on:click={() => resetUsed(entry.providerId, entry.model)}
            />
          {:else}
            <span class="content-dark-color text-sm no-word-wrap"><Label label={plugin.string.NoLimit} /></span>
            <span class="model-bar" />
            <EditBox
              kind="default"
              format="number"
              bind:value={newLimit[key]}
              placeholder={plugin.string.PurchasedTokens}
            />
            <Button
              label={plugin.string.SetLimit}
              kind="regular"
              on:click={() => setLimit(entry.providerId, entry.model)}
            />
          {/if}
        </div>
      {/each}
    </div>

    <div class="fs-title mt-2"><Label label={plugin.string.SectionASR} /></div>
    <div class="flex-col flex-gap-2">
      <div class="text-sm content-dark-color"><Label label={plugin.string.AsrByModel} /></div>
      {#if asrByModel.length === 0}
        <div class="content-dark-color text-sm"><Label label={plugin.string.NoData} /></div>
      {/if}
      {#each asrByModel as row (row.level)}
        <div class="model-card flex-between">
          <span class="font-medium">{row.level !== undefined && row.level !== '' ? row.level : '-'}</span>
          <span class="text-sm no-word-wrap">{formatMinutes(row.durationSeconds / 60)}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style lang="scss">
  .model-card {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
    background: var(--theme-list-row-color);
  }
  .model-name {
    flex: 0 0 16rem;
    min-width: 0;
  }
  .model-bar {
    flex: 1 1 auto;
    min-width: 6rem;
  }
</style>
