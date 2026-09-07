<!--
// Copyright © 2026 Intabia Fusion.
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
  import { Label, tooltip } from '@hcengineering/ui'
  import type { IntlString } from '@hcengineering/platform'
  import billingPlugin from '@hcengineering/billing'
  import { filesize } from 'filesize'

  interface TypeStats {
    type: string
    count: number
    size: number
  }

  export let byType: TypeStats[] = []
  export let totalSize: number = 0
  export let limit: number = 0

  interface SegmentInfo {
    label: IntlString
    color: string
    size: number
    count: number
    percentage: number
  }

  const typeConfig: Record<string, { label: IntlString, color: string }> = {
    image: { label: billingPlugin.string.Images, color: 'var(--theme-state-primary-color)' },
    video: { label: billingPlugin.string.Videos, color: 'var(--theme-state-negative-color)' },
    audio: { label: billingPlugin.string.Audio, color: 'var(--theme-state-warning-color)' },
    document: { label: billingPlugin.string.Documents, color: '#77C07B' },
    archive: { label: billingPlugin.string.Archives, color: '#9B8AE0' },
    other: { label: billingPlugin.string.OtherFiles, color: 'var(--theme-content-color)' }
  }

  let segments: SegmentInfo[] = []
  let usedPercentage: number = 0

  $: {
    const used = totalSize > 0 ? totalSize : byType.reduce((s, t) => s + t.size, 0)
    const base = limit > 0 ? limit : used
    usedPercentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 100
    segments = byType
      .map((t) => {
        const config = typeConfig[t.type] ?? typeConfig.other
        return {
          label: config.label,
          color: config.color,
          size: t.size,
          count: t.count,
          percentage: base > 0 ? (t.size / base) * 100 : 0
        }
      })
      .filter((s) => s.size > 0)
      .sort((a, b) => b.size - a.size)
  }
</script>

<div class="breakdown-container">
  {#if limit > 0}
    <div class="usage-summary">
      <span class="usage-text">{filesize(totalSize, { spacer: ' ' })}</span>
      <span class="usage-separator"> / </span>
      <span class="usage-limit">{filesize(limit, { spacer: ' ' })}</span>
    </div>
  {/if}
  <div class="bar-container">
    {#each segments as segment}
      <div
        class="bar-segment"
        style="width: {Math.max(segment.percentage, 1)}%; background-color: {segment.color}"
        use:tooltip={{ label: segment.label }}
      />
    {/each}
  </div>
  <div class="legend">
    {#each segments as segment}
      <div class="legend-item">
        <div class="legend-dot" style="background-color: {segment.color}" />
        <span class="legend-label"><Label label={segment.label} /></span>
        <span class="legend-value">{filesize(segment.size, { spacer: ' ' })} ({segment.count})</span>
      </div>
    {/each}
  </div>
</div>

<style lang="scss">
  .breakdown-container {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .usage-summary {
    display: flex;
    align-items: baseline;
    font-size: 0.8125rem;
  }

  .usage-text {
    color: var(--theme-content-color);
    font-weight: 500;
  }

  .usage-separator {
    color: var(--theme-halfcontent-color);
  }

  .usage-limit {
    color: var(--theme-halfcontent-color);
  }

  .bar-container {
    display: flex;
    height: 1.25rem;
    border-radius: 0.5rem;
    overflow: hidden;
    background-color: var(--theme-button-default);
    border: 1px solid var(--theme-button-border);
  }

  .bar-segment {
    min-width: 2px;
    transition: width 0.3s ease;

    &:first-child {
      border-radius: 0.5rem 0 0 0.5rem;
    }

    &:last-child {
      border-radius: 0 0.5rem 0.5rem 0;
    }
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .legend-label {
    font-size: 0.8125rem;
    color: var(--theme-content-color);
  }

  .legend-value {
    font-size: 0.8125rem;
    color: var(--theme-halfcontent-color);
  }
</style>
