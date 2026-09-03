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
  import type { Subscription } from '@hcengineering/account-client'
  import { type PlanItem, type PackageItem, currencyOf, planCharge } from '@hcengineering/billing'
  import { Card } from '@hcengineering/presentation'
  import { Button, EditBox, Label } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import adminRes from '../plugin'
  import { fmtAmount, getAccountClient, requestAdminOtpCode } from '../utils'

  export let subscription: Subscription
  export let perSeatPlan: boolean = false
  export let planItem: PlanItem | PackageItem | undefined = undefined

  const dispatch = createEventDispatcher()
  const accountClient = getAccountClient()

  let seats: number = subscription.limits?.usersLimit ?? 1
  // For a trial edit the end date IS the trial end (server mirrors it to periodEnd).
  const isTrial = subscription.status === 'trialing'
  const endMs = isTrial ? (subscription.trialEnd ?? subscription.periodEnd) : subscription.periodEnd
  // Date input as YYYY-MM-DD; empty means "keep as is"
  const initialEndDate: string = endMs != null ? new Date(endMs).toISOString().slice(0, 10) : ''
  let periodEndDate: string = initialEndDate
  let saving = false

  const currency = currencyOf(planItem)
  const period = subscription.providerData?.period === 'yearly' ? 'yearly' : 'monthly'
  const initialSeats = subscription.limits?.usersLimit ?? 0
  // The row stores kopecks; the admin edits whole rubles.
  const initialAmountRub = Math.round((subscription.amount ?? 0) / 100)
  let amountRub: number = initialAmountRub

  const willAutoCharge =
    subscription.providerData?.recurrent !== false &&
    subscription.providerData?.rebillId != null &&
    subscription.willCancelAt == null &&
    !isTrial

  $: canRecalc = planItem != null && planCharge(planItem, Math.round(seats), period) > 0
  $: periodChanged = periodEndDate !== '' && periodEndDate !== initialEndDate
  $: periodMs = periodChanged ? new Date(periodEndDate + 'T' + timeOfDayUTC(endMs)).getTime() : undefined
  $: movedToPast = periodMs != null && periodMs <= Date.now() && (endMs == null || endMs > Date.now())
  $: seatsChanged = perSeatPlan && Number.isFinite(seats) && seats >= 1 && Math.round(seats) !== initialSeats
  $: amountChanged = Number.isFinite(amountRub) && Math.round(amountRub) !== initialAmountRub
  $: priceStale = seatsChanged && !amountChanged
  // Counting new token limit that depends on seats. Only the UI has plan-config.
  $: windowMonthLimit = (() => {
    if (!seatsChanged || planItem == null || !('windowMonthLimit' in planItem)) return undefined
    const base = planItem.windowMonthLimit ?? 0
    if (base === 0) return undefined
    return perSeatPlan ? base * Math.round(seats) : base
  })()

  /** Time-of-day part of a timestamp as HH:MM:SS.sssZ; midnight when there is no source timestamp. */
  function timeOfDayUTC (ms: number | undefined): string {
    return ms != null ? new Date(ms).toISOString().slice(11) : '00:00:00.000Z'
  }

  function recalcPrice (): void {
    amountRub = Math.round(planCharge(planItem, Math.round(seats), period) / 100)
  }

  async function save (): Promise<void> {
    if (saving) return
    if (!seatsChanged && !periodChanged && !amountChanged) {
      dispatch('close', undefined)
      return
    }
    // Subscription edit is billing-impactful -> OTP-gated on the server
    const code = await requestAdminOtpCode()
    if (code === undefined) return
    saving = true
    try {
      await accountClient.adminUpdateSubscription(
        subscription.id,
        code,
        seatsChanged ? Math.round(seats) : undefined,
        periodChanged ? periodMs : undefined,
        amountChanged ? Math.round(amountRub) * 100 : undefined,
        windowMonthLimit
      )
      dispatch('close', true)
    } catch (err) {
      console.error('Failed to update subscription:', err)
    } finally {
      saving = false
    }
  }
</script>

<Card
  label={adminRes.string.EditSubscription}
  okLabel={adminRes.string.Save}
  canSave={!saving}
  okAction={save}
  on:close={() => dispatch('close', undefined)}
>
  <div class="flex-col">
    {#if perSeatPlan}
      <div class="flex-row-center mb-2">
        <span class="mr-2"><Label label={adminRes.string.Seats} />:</span>
        <div class="num-input">
          <EditBox bind:value={seats} format={'number'} kind={'default'} placeholder={adminRes.string.EnterNumber} />
        </div>
      </div>
    {/if}
    <div class="flex-row-center mb-2">
      <span class="mr-2"><Label label={isTrial ? adminRes.string.TrialEnd : adminRes.string.PeriodEnd} />:</span>
      <input type="date" bind:value={periodEndDate} class="date-input" />
    </div>
    <div class="flex-row-center">
      <span class="mr-2"><Label label={adminRes.string.PricePerPeriod} />, {currency}:</span>
      <div class="price-input">
        <EditBox bind:value={amountRub} format={'number'} kind={'default'} placeholder={adminRes.string.EnterNumber} />
      </div>
      {#if canRecalc}
        <div class="ml-2">
          <Button label={adminRes.string.RecalculatePrice} size={'small'} on:click={recalcPrice} />
        </div>
      {/if}
    </div>
    <div class="warnings">
      {#if priceStale}
        <div class="warn-text">
          <Label
            label={adminRes.string.PriceNotRecalculated}
            params={{ amount: fmtAmount(initialAmountRub * 100, currency) }}
          />
        </div>
      {/if}
      {#if movedToPast}
        <div class="warn-text">
          {#if willAutoCharge}
            <Label
              label={adminRes.string.PeriodEndInPast}
              params={{ amount: fmtAmount(Math.round(amountRub) * 100, currency) }}
            />
          {:else}
            <Label label={adminRes.string.PeriodEndInPastNoCharge} />
          {/if}
        </div>
      {/if}
    </div>
  </div>
</Card>

<style lang="scss">
  .num-input {
    width: 7rem;
  }
  .price-input {
    width: 9rem;
  }
  // Space for both warnings is reserved up front: appearing ones must not push the dialog around.
  .warnings {
    margin-top: 0.5rem;
    min-height: 2.25rem;
  }
  .warn-text {
    color: var(--theme-warning-color);
    font-size: 0.75rem;
    line-height: 1.125rem;
  }
  // Matches EditBox kind='default' so the three fields in this form read as one set.
  .date-input {
    background: var(--theme-bg-color);
    color: var(--theme-content-color);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;
    padding: 0.3125rem 0.5rem;
    line-height: 1.25rem;
  }
</style>
