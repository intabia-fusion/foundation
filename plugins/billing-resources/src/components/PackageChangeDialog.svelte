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
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Card } from '@hcengineering/presentation'
  import { Label, CheckBox, themeStore } from '@hcengineering/ui'
  import { type SubscriptionData } from '@hcengineering/payment-client'
  import plugin from '../plugin'
  import { proratePackage } from '@hcengineering/account-client'

  // The active package subscription being replaced, and the target package price/label.
  export let subscription: SubscriptionData
  export let currentLabel: string = '' // currently connected package
  export let targetLabel: string = '' // package the user picked
  export let targetPriceKopecks: number // recurring price of the new package (kopecks)
  export let currency: string = ''
  // Recurring-charge consent, seeded from the subscription being replaced so a plain swap keeps it.
  export let recurrent: boolean = true

  const dispatch = createEventDispatcher()
  const DEFAULT_LOCALE = 'ru'
  $: lang = $themeStore.language ?? DEFAULT_LOCALE

  $: canPreview = subscription.amount != null && subscription.periodStart != null && subscription.periodEnd != null
  $: preview = canPreview
    ? proratePackage({
        oldAmount: subscription.amount ?? 0,
        periodStart: subscription.periodStart ?? 0,
        periodEnd: subscription.periodEnd ?? 0,
        now: Date.now(),
        newFullPrice: targetPriceKopecks
      })
    : undefined

  $: isUpgrade = preview?.isUpgrade ?? false
  $: extraDays =
    preview !== undefined && subscription.periodEnd != null
      ? Math.max(0, Math.round((preview.periodEnd - subscription.periodEnd) / (24 * 3600 * 1000)))
      : 0

  function fmt (kopecks: number): string {
    return new Intl.NumberFormat(lang).format(Math.round(kopecks / 100))
  }
  function fmtDate (ms: number): string {
    return new Date(ms).toLocaleDateString(lang)
  }

  async function apply (): Promise<void> {
    dispatch('close', { recurrent })
  }
</script>

<Card
  label={plugin.string.ConfirmConnectPackage}
  okLabel={plugin.string.Connect}
  width="small"
  okAction={apply}
  canSave={true}
  on:close={() => {
    dispatch('close')
  }}
  on:changeContent
>
  <div class="flex-col flex-gap-4" data-id="packageChangeDialog">
    <div class="text-md content-color">
      <Label label={plugin.string.ReplacePackageSwitch} params={{ current: currentLabel, target: targetLabel }} />
    </div>

    {#if preview !== undefined}
      <div class="preview flex-col flex-gap-2" data-id="packagePreview">
        {#if isUpgrade}
          <div data-id="packageChargeRow">
            <Label label={plugin.string.SeatChargeNow} params={{ amount: `${fmt(preview.charge)} ${currency}` }} />
          </div>
        {:else}
          <div data-id="packageExtendRow">
            <Label
              label={plugin.string.SeatDowngradeExtends}
              params={{ days: extraDays, date: fmtDate(preview.periodEnd) }}
            />
          </div>
        {/if}
        {#if recurrent}
          <div class="dark-color text-sm" data-id="packageNewPrice">
            <Label
              label={plugin.string.NewRecurringPrice}
              params={{ amount: `${fmt(targetPriceKopecks)} ${currency}` }}
            />
          </div>
        {/if}
      </div>
    {/if}

    <!-- One-off purchase, no card is saved, no auto-renew, the package ends at period end. -->
    <div class="flex-row-top flex-gap-2" data-id="packageRecurrentCheckbox">
      <CheckBox id="package-recurrent-input" bind:checked={recurrent} kind={'primary'} />
      <span class="text-sm">
        <label for="package-recurrent-input" class="cursor-pointer">
          <Label
            label={plugin.string.AgreeMonthlyCharge}
            params={{ amount: `${fmt(targetPriceKopecks)} ${currency}` }}
          />
        </label>
      </span>
    </div>
    {#if !recurrent}
      <div class="text-sm dark-color" data-id="packageNoRenewalHint">
        <Label label={plugin.string.NoAutoRenewalHint} />
      </div>
    {/if}
  </div>
</Card>

<style lang="scss">
  .preview {
    padding: var(--spacing-2);
    border-radius: var(--small-BorderRadius);
    background: var(--theme-bg-color);
  }
</style>
