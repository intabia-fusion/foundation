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
  import type { WorkspaceTokenWindows } from '@hcengineering/billing-client'
  import { formatNumberCompact, Label, PaletteColorIndexes, Progress, themeStore } from '@hcengineering/ui'
  import plugin from '../plugin'

  export let windows: WorkspaceTokenWindows | undefined

  $: lang = $themeStore.language

  function barColor (used: number, limit: number): PaletteColorIndexes | undefined {
    if (limit <= 0) return undefined
    const ratio = used / limit
    if (ratio >= 1) return PaletteColorIndexes.Firework
    if (ratio >= 0.75) return PaletteColorIndexes.Sunshine
    return PaletteColorIndexes.Grass
  }

  function resetTime (iso: string | null, locale: string): string {
    if (iso === null) return ''
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'minute')
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
    const mins = Math.round(ms / 60000)
    if (mins < 60) return rtf.format(mins, 'minute')
    const hours = Math.round(ms / 3600000)
    if (hours < 24) return rtf.format(hours, 'hour')
    return rtf.format(Math.round(ms / 86400000), 'day')
  }

  // Token counts run to eight digits; full numbers do not fit the row.
  const fmt = (n: number): string => formatNumberCompact(n, 1)

  // 0 stays 0: an unlimited monthly grant is unlimited whatever the balance is.
  $: monthTotal = windows === undefined || windows.month.limit === 0 ? 0 : windows.month.limit + windows.balance
</script>

<!-- The bar spans grant + pack: the pack is charged at period end, but it is spendable now,
     so measuring against the grant alone showed a workspace as full while it still had tokens. -->
{#if windows !== undefined}
  <div class="flex-col flex-gap-2 mt-2" data-id="tokenWindows">
    <div class="flex-col flex-gap-1">
      <div class="flex-between flex-gap-2 text-md">
        <span><Label label={plugin.string.TokenAvailable} /></span>
        <span class="content-dark-color no-word-wrap" data-id="tokenAvailable">
          {windows.available !== null ? fmt(windows.available) : '∞'}
        </span>
      </div>
      <Progress
        color={barColor(windows.month.used, monthTotal)}
        value={windows.month.used}
        max={monthTotal}
        fallback={0}
      />
      <div class="flex-between flex-gap-2 text-sm content-dark-color">
        <span><Label label={plugin.string.TokenWindowMonth} /></span>
        <span class="no-word-wrap">
          {fmt(windows.month.used)} / {monthTotal > 0 ? fmt(monthTotal) : '∞'}
        </span>
      </div>
      {#if windows.month.resetAt !== null && windows.month.limit > 0}
        <span class="text-sm content-dark-color">
          <Label label={plugin.string.ResetsAt} params={{ time: resetTime(windows.month.resetAt, lang) }} />
        </span>
      {/if}
      {#if windows.balance > 0}
        <div class="flex-between flex-gap-2 text-sm content-dark-color">
          <span><Label label={plugin.string.TokenPurchased} /></span>
          <span class="no-word-wrap" data-id="tokenPurchased">{fmt(windows.balance)}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
