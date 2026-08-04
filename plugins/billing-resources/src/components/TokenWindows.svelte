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
  import { Label, PaletteColorIndexes, Progress } from '@hcengineering/ui'
  import plugin from '../plugin'

  export let windows: WorkspaceTokenWindows | undefined

  function barColor (used: number, limit: number): PaletteColorIndexes | undefined {
    if (limit <= 0) return undefined
    const ratio = used / limit
    if (ratio >= 1) return PaletteColorIndexes.Firework
    if (ratio >= 0.75) return PaletteColorIndexes.Sunshine
    return PaletteColorIndexes.Grass
  }

  function resetTime (iso: string | null): string {
    if (iso === null) return ''
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'minute')
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
    const mins = Math.round(ms / 60000)
    if (mins < 60) return rtf.format(mins, 'minute')
    const hours = Math.round(ms / 3600000)
    if (hours < 24) return rtf.format(hours, 'hour')
    return rtf.format(Math.round(ms / 86400000), 'day')
  }
</script>

{#if windows !== undefined}
  <div class="flex-col flex-gap-2 mt-2" data-id="tokenWindows">
    <div class="flex-col flex-gap-1">
      <div class="flex-between flex-gap-2 text-md">
        <span><Label label={plugin.string.TokenWindowMonth} /></span>
        <span class="content-dark-color no-word-wrap">
          {windows.month.used.toLocaleString('en-US')} / {windows.month.limit > 0
            ? windows.month.limit.toLocaleString('en-US')
            : '∞'}{windows.isFree === false && windows.basicLevelLabel !== ''
              ? ` + (${windows.basicLevelLabel} ∞)`
              : ''}
        </span>
      </div>
      <Progress
        color={barColor(windows.month.used, windows.month.limit)}
        value={windows.month.used}
        max={windows.month.limit}
        fallback={0}
      />
      {#if windows.month.resetAt !== null}
        <span class="text-sm content-dark-color">
          <Label label={plugin.string.ResetsAt} params={{ time: resetTime(windows.month.resetAt) }} />
        </span>
      {/if}
      {#if (windows.month.rollover ?? 0) > 0}
        <div class="flex-between flex-gap-2 text-sm content-dark-color">
          <span><Label label={plugin.string.PackageRollover} /></span>
          <span class="no-word-wrap">+{(windows.month.rollover ?? 0).toLocaleString('en-US')}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
