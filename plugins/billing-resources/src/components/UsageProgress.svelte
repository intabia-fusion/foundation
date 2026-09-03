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
  import { IntlString } from '@hcengineering/platform'
  import { Label, PaletteColorIndexes, Progress, humanReadableFileSize, humanReadableNumbers } from '@hcengineering/ui'
  import plugin from '../plugin'
  import { formatMinutes } from '../billingFormat'

  export let label: IntlString
  export let value: number
  export let limit: number

  export let kind: 'bytes' | 'items' | 'minutes' = 'bytes'

  function barColor (used: number, max: number): PaletteColorIndexes | undefined {
    if (max <= 0) return undefined
    const ratio = used / max
    if (ratio >= 1) return PaletteColorIndexes.Firework
    if (ratio >= 0.75) return PaletteColorIndexes.Sunshine
    return PaletteColorIndexes.Grass
  }

  $: color = barColor(value, limit)

  const GB = 1e9
  const TB_THRESHOLD = 1e13 // 10 TB: above this, raw GB gets too long to read

  // A 50 GB plan plus a 1000 GB package rounds to "1 TB" and hides the package.
  function formatBytes (v: number): string {
    if (v >= GB && v < TB_THRESHOLD) return `${Math.round(v / GB)} GB`
    return humanReadableFileSize(v, 10, 0)
  }

  function formatValue (v: number): string {
    if (kind === 'bytes') return formatBytes(v)
    if (kind === 'minutes') return formatMinutes(v)
    return humanReadableNumbers(v, 10, 0)
  }
</script>

<div class="flex-col flex-gap-2">
  <div class="flex-between text-md">
    <span class="pr-2"><Label {label} /></span>
    <span class="flex-row-center flex-gap-1">
      {formatValue(value)}
      <Label label={plugin.string.Of} />
      {#if limit === 0}
        <span>&infin;</span>
      {:else}
        <span>{formatValue(limit)}</span>
      {/if}
    </span>
  </div>
  <Progress {color} {value} max={limit} fallback={0} />
</div>
