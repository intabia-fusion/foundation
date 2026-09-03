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
  import { EditBox, Label, Loading } from '@hcengineering/ui'
  import type { AiTokensBreakdown, BillingPricing } from '@hcengineering/billing-client'
  import { getBillingClient } from '../utils'
  import plugin from '../plugin'
  import { tokenCost, priceForKey, fmtRub } from '../billingFormat'

  let loading = true
  let byModel: AiTokensBreakdown[] = []
  let pricing: BillingPricing | undefined

  let calcPricePer1000 = 0.065
  let customTokens = 1000000

  // Package calculator: sale price (margin included) -> tokens the purchase covers.
  let pkgMarginPct = 20
  const pkgPrices = [250, 1000, 2500]

  $: totalCost = byModel.reduce((s, b) => s + tokenCost(b.rawTokens ?? b.totalTokens, priceForKey(pricing, b.model)), 0)
  $: cost100k = tokenCost(100000, calcPricePer1000)
  $: customCost = tokenCost(customTokens, calcPricePer1000)

  // Strip the margin to get the purchase cost, then convert to tokens at the provider price.
  $: pkgRows = pkgPrices.map((price) => {
    const purchase = price / (1 + pkgMarginPct / 100)
    const tokens = calcPricePer1000 > 0 ? Math.floor((purchase / calcPricePer1000) * 1000) : 0
    return { price, tokens, effPer1000: tokens > 0 ? (price / tokens) * 1000 : 0 }
  })

  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const elapsedFrac = Math.min(1, now.getDate() / daysInMonth)

  $: forecastCost = elapsedFrac > 0 ? totalCost / elapsedFrac : totalCost

  onMount(async () => {
    const client = getBillingClient()
    if (client === null) {
      loading = false
      return
    }
    try {
      ;[byModel, pricing] = await Promise.all([client.getTokenUsage('model'), client.getPricing()])
    } finally {
      loading = false
    }
  })
</script>

{#if loading}
  <Loading />
{:else}
  <div class="flex-col flex-gap-3 p-4">
    <section class="flex-col flex-gap-3">
      <div class="fs-title"><Label label={plugin.string.Calculator} /></div>
      <div class="flex-row-center flex-gap-4">
        <div class="flex-col flex-gap-1">
          <span class="text-sm content-dark-color"><Label label={plugin.string.PricePer1000} /></span>
          <EditBox format="number" bind:value={calcPricePer1000} />
        </div>
        <div class="flex-col flex-gap-1">
          <span class="text-sm content-dark-color"><Label label={plugin.string.CustomTokens} /></span>
          <EditBox format="number" bind:value={customTokens} />
        </div>
      </div>
      <div class="flex-col flex-gap-1 text-md">
        <div class="flex-between">
          <Label label={plugin.string.CostPer100k} />
          <span>{fmtRub(cost100k)}</span>
        </div>
        <div class="flex-between">
          <span>
            <Label label={plugin.string.CustomTokensCost} />
            <span class="content-dark-color">({customTokens.toLocaleString('en-US')})</span>
          </span>
          <span>{fmtRub(customCost)}</span>
        </div>
      </div>
    </section>

    <section class="flex-col flex-gap-3">
      <div class="fs-title"><Label label={plugin.string.PackagesTitle} /></div>
      <div class="flex-row-center flex-gap-4">
        <div class="flex-col flex-gap-1">
          <span class="text-sm content-dark-color"><Label label={plugin.string.PackageMargin} /></span>
          <EditBox format="number" bind:value={pkgMarginPct} />
        </div>
      </div>
      <div class="flex-col flex-gap-2">
        <div class="text-sm content-dark-color"><Label label={plugin.string.PackagePrice} /></div>
        {#each pkgRows as row, i}
          <div class="flex-row-center flex-gap-4">
            <div style="width: 8rem">
              <EditBox format="number" bind:value={pkgPrices[i]} />
            </div>
            <div class="flex-col flex-gap-1 flex-grow">
              <div class="flex-between text-md">
                <span class="content-dark-color"><Label label={plugin.string.PackageTokens} /></span>
                <span>{row.tokens.toLocaleString('en-US')}</span>
              </div>
              <div class="flex-between text-sm content-dark-color">
                <span><Label label={plugin.string.PackageEffPrice} /></span>
                <span>{fmtRub(row.effPer1000)}</span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section class="flex-col flex-gap-3">
      <div class="fs-title"><Label label={plugin.string.Forecast} /></div>
      <div class="flex-col flex-gap-1 text-md">
        <div class="flex-between">
          <Label label={plugin.string.ForecastMonthly} />
          <span>{fmtRub(forecastCost)}</span>
        </div>
      </div>
    </section>
  </div>
{/if}
