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
  import { NumberInput, Label, themeStore } from '@hcengineering/ui'
  import { type SubscriptionData } from '@hcengineering/payment-client'
  import plugin from '../plugin'
  import { prorateSeats } from '@hcengineering/account-client'

  // The active per-seat subscription being changed (tier or package).
  export let subscription: SubscriptionData
  // Full recurring price (kopecks) for a given seat count and the current period — from the caller,
  // which already knows the plan prices/period. seats -> price.
  export let recurringPriceFor: (seats: number) => number
  // Seat floor: current member count. Cannot drop below it.
  export let minSeats: number
  // Seat ceiling: guards against huge values (sci-notation price + provider 500). From the caller.
  export let maxSeats: number
  export let currency: string = ''
  // One-off purchase
  export let oneOff: boolean = false

  const dispatch = createEventDispatcher()
  const DEFAULT_LOCALE = 'ru'

  const oldSeats = Number(subscription.providerData?.quantity ?? minSeats)
  let seats = Math.max(oldSeats, minSeats)

  $: lang = $themeStore.language ?? DEFAULT_LOCALE

  // Instant, request-free preview mirroring the server formula. Server recomputes on apply.
  $: canPreview = subscription.amount != null && subscription.periodStart != null && subscription.periodEnd != null
  $: preview = canPreview
    ? prorateSeats({
        oldAmount: subscription.amount ?? 0,
        oldSeats,
        periodStart: subscription.periodStart ?? 0,
        periodEnd: subscription.periodEnd ?? 0,
        now: Date.now(),
        newSeats: seats,
        newFullPrice: recurringPriceFor(seats)
      })
    : undefined

  $: newRecurring = recurringPriceFor(seats)
  $: changed = seats !== oldSeats
  // Downgrade: how many days the renewal date shifts forward (credit for removed seats).
  $: extraDays =
    preview !== undefined && !preview.isUpgrade && subscription.periodEnd != null
      ? Math.max(0, Math.round((preview.periodEnd - subscription.periodEnd) / (24 * 3600 * 1000)))
      : 0

  function fmt (kopecks: number): string {
    return new Intl.NumberFormat(lang).format(Math.round(kopecks / 100))
  }
  function fmtDate (ms: number): string {
    return new Date(ms).toLocaleDateString(lang)
  }

  async function apply (): Promise<void> {
    dispatch('close', seats)
  }
</script>

<Card
  label={plugin.string.ChangeSeatsTitle}
  okLabel={plugin.string.ChangeSeats}
  width="small"
  okAction={apply}
  canSave={changed && seats >= minSeats}
  on:close={() => {
    dispatch('close')
  }}
  on:changeContent
>
  <div class="flex-col flex-gap-4" data-id="changeSeatsDialog">
    <div class="text-md content-color"><Label label={plugin.string.ChangeSeatsDescription} /></div>

    <div class="flex-col flex-gap-2" data-id="changeSeatsInput">
      <Label label={plugin.string.UsersCount} />
      <NumberInput bind:value={seats} minValue={minSeats} maxValue={maxSeats} maxDigitsAfterPoint={0} focusable />
      <div class="text-sm dark-color">
        <Label label={plugin.string.SeatMinHint} params={{ min: minSeats }} />
      </div>
    </div>

    {#if changed && preview !== undefined}
      <div class="preview flex-col flex-gap-2" data-id="seatPreview">
        {#if preview.isUpgrade}
          <div class="flex-row-center flex-gap-1" data-id="seatChargeRow">
            <Label label={plugin.string.SeatChargeNow} params={{ amount: `${fmt(preview.charge)} ${currency}` }} />
          </div>
        {:else}
          <div class="flex-row-center flex-gap-1" data-id="seatExtendRow">
            <Label
              label={oneOff ? plugin.string.SeatDowngradeExtendsOneOff : plugin.string.SeatDowngradeExtends}
              params={{ days: extraDays, date: fmtDate(preview.periodEnd) }}
            />
          </div>
        {/if}
        {#if !oneOff}
          <div class="flex-row-center flex-gap-1 dark-color text-sm" data-id="seatNewPrice">
            <Label label={plugin.string.NewRecurringPrice} params={{ amount: `${fmt(newRecurring)} ${currency}` }} />
          </div>
        {/if}
      </div>
    {:else if !changed}
      <div class="text-sm dark-color"><Label label={plugin.string.SeatsUnchanged} /></div>
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
