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
  import { NumberInput, Label, CheckBox, Switcher, themeStore } from '@hcengineering/ui'
  import { type BillingPeriod } from '@hcengineering/payment-client'
  import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
  import plugin from '../plugin'

  // Dialog title + confirm label vary by intent (first purchase vs plan change).
  export let label: IntlString
  export let okLabel: IntlString
  // Per-seat plans pass a seats input; flat plans hide it and bill a fixed price.
  export let perSeat: boolean = true
  export let minSeats: number = 1
  export let maxSeats: number = 1
  export let seats: number = minSeats
  export let period: BillingPeriod = 'monthly'
  // Availability of monthly/yearly switcher
  export let selectablePeriod: boolean = true
  // seats + period -> full charge for that period, in rubles. Supplied by the caller,
  // which owns the plan pricing (discount, flat vs per-seat).
  export let chargeFor: (seats: number, period: BillingPeriod) => number
  // Effective monthly price per seat for a period (yearly applies the plan discount), in rubles.
  export let monthlyPerSeatFor: ((period: BillingPeriod) => number) | undefined = undefined
  export let yearlyDiscount: number = 0
  export let currency: string = ''
  // Auto-renewal is the expected default; unchecking makes it a one-off payment with no card saved.
  export let recurrent: boolean = true
  // One-off catalog purchases: force non-recurring and hide the auto-renew consent entirely.
  export let hideRecurrent: boolean = false
  $: if (hideRecurrent) recurrent = false

  const dispatch = createEventDispatcher()
  const DEFAULT_LOCALE = 'ru'

  $: lang = $themeStore.language ?? DEFAULT_LOCALE

  $: periodItems = [
    { id: 'monthly', labelIntl: plugin.string.PaymentMonth },
    {
      id: 'yearly',
      labelIntl: plugin.string.PaymentYear,
      // Language-neutral "−N%" hint, matching the plan-card switcher.
      badge: yearlyDiscount > 0 ? getEmbeddedLabel(`−${yearlyDiscount}%`) : undefined
    }
  ]

  $: effectiveSeats = perSeat ? Math.min(Math.max(seats, minSeats), maxSeats) : 1
  $: total = chargeFor(effectiveSeats, period)
  // Monthly is the default pick, so promote the cheaper yearly option: its discounted
  // per-month price and the resulting yearly total.
  $: showYearlyOffer = selectablePeriod && period === 'monthly' && yearlyDiscount > 0
  $: yearlyPerMonth = showYearlyOffer ? (monthlyPerSeatFor?.('yearly') ?? 0) * effectiveSeats : 0
  $: yearlyTotal = showYearlyOffer ? chargeFor(effectiveSeats, 'yearly') : 0

  function fmt (value: number): string {
    return new Intl.NumberFormat(lang).format(Math.round(value))
  }

  async function apply (): Promise<void> {
    dispatch('close', { seats: effectiveSeats, period, recurrent })
  }
</script>

<Card
  {label}
  {okLabel}
  width="small"
  okAction={apply}
  canSave={!perSeat || (effectiveSeats >= minSeats && effectiveSeats <= maxSeats)}
  on:close={() => {
    dispatch('close')
  }}
  on:changeContent
>
  <div class="flex-col flex-gap-4" data-id="planCheckoutDialog">
    {#if perSeat}
      <div class="flex-col flex-gap-2" data-id="checkoutSeatsInput">
        <Label label={plugin.string.UsersCount} />
        <NumberInput bind:value={seats} minValue={minSeats} maxValue={maxSeats} maxDigitsAfterPoint={0} focusable />
        <div class="text-sm dark-color">
          <Label label={plugin.string.SeatMinHint} params={{ min: minSeats }} />
        </div>
      </div>
    {/if}

    {#if selectablePeriod}
      <div class="flex-col flex-gap-2" data-id="checkoutPeriodSwitch">
        <Label label={plugin.string.BillingPeriodLabel} />
        <div class="flex">
          <Switcher
            name={'checkoutPeriod'}
            items={periodItems}
            selected={period}
            kind={'subtle'}
            on:select={(e) => {
              if (e?.detail?.id !== undefined) period = e.detail.id
            }}
          />
        </div>
      </div>
    {/if}

    <div class="preview flex-col flex-gap-2" data-id="checkoutTotal">
      <div class="flex-row-center flex-gap-1">
        <Label label={plugin.string.Total} />:
        <span class="fs-title">{fmt(total)} {currency}</span>
      </div>
      {#if showYearlyOffer}
        <div class="dark-color text-sm" data-id="checkoutYearlyHint">
          <Label
            label={plugin.string.YearlyOfferHint}
            params={{ perMonth: `${fmt(yearlyPerMonth)} ${currency}`, total: `${fmt(yearlyTotal)} ${currency}` }}
          />
        </div>
      {/if}
    </div>

    <!-- Opt-in: unchecked sends no Recurrent to the provider, so no card is saved and the
         subscription simply ends at period end instead of auto-renewing. -->
    {#if !hideRecurrent}
      <div class="flex-row-top flex-gap-2" data-id="checkoutRecurrentCheckbox">
        <CheckBox id="recurrent-input" bind:checked={recurrent} kind={'primary'} />
        <span class="text-sm">
          <label for="recurrent-input" class="cursor-pointer">
            <Label
              label={period === 'yearly' ? plugin.string.AgreeYearlyCharge : plugin.string.AgreeMonthlyCharge}
              params={{ amount: `${fmt(total)} ${currency}` }}
            />
          </label>
        </span>
      </div>
      {#if !recurrent}
        <div class="text-sm dark-color" data-id="checkoutNoRenewalHint">
          <Label label={plugin.string.NoAutoRenewalHint} />
        </div>
      {/if}
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
