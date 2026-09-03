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
  import aiBot, { type AIFeature, type AILevelInfo } from '@hcengineering/ai-bot'
  import { type IntlString } from '@hcengineering/platform'
  import { Label } from '@hcengineering/ui'

  export let levels: AILevelInfo[] = []

  const FEATURES: Array<[AIFeature, IntlString]> = [
    ['chat', aiBot.string.AILevelChat],
    ['talk', aiBot.string.AILevelTalk],
    ['summary', aiBot.string.AILevelSummary],
    ['tasks', aiBot.string.AILevelTasks]
  ]

  // Unset flag = allowed, so a level with no `features` block serves everything.
  const isOn = (info: AILevelInfo, feature: AIFeature): boolean => info.features?.[feature] !== false
</script>

<div class="matrix" style:grid-template-columns={`minmax(8rem, auto) repeat(${levels.length}, 1fr)`}>
  <span />
  {#each levels as info (info.level)}
    <span class="head">{info.label}</span>
  {/each}

  {#each FEATURES as [feature, label]}
    <span class="feature"><Label {label} /></span>
    {#each levels as info (info.level)}
      <span class="cell" class:off={!isOn(info, feature)}>{isOn(info, feature) ? '✓' : '—'}</span>
    {/each}
  {/each}
</div>

<style lang="scss">
  .matrix {
    display: grid;
    align-items: center;
    row-gap: 0.375rem;
    column-gap: 0.75rem;
  }

  .head {
    font-weight: 500;
    color: var(--theme-caption-color);
    text-align: center;
    padding-bottom: 0.25rem;
  }

  .feature {
    font-size: 0.75rem;
    color: var(--theme-content-color);
  }

  .cell {
    text-align: center;
    color: var(--theme-content-color);

    &.off {
      color: var(--theme-darker-color);
    }
  }
</style>
