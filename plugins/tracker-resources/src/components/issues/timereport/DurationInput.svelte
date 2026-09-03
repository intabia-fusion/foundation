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
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { Button, EditBox, Label, themeStore } from '@hcengineering/ui'
  import { durationFormatHint, formatDuration, parseDuration } from '@hcengineering/tracker'
  import tracker from '../../../plugin'

  export let hours: number | undefined = undefined
  export let readonly = false
  export let showQuickButtons = true
  export let autoFocus = true

  let textValue = hours !== undefined ? formatDuration(hours, $themeStore.language) : ''

  $: hint = durationFormatHint($themeStore.language)
  $: hours = parseDuration(textValue)
  $: isInvalid = textValue.trim() !== '' && hours === undefined
  $: normalized = hours !== undefined ? formatDuration(hours, $themeStore.language) : ''

  export function setDurationText (value: number): void {
    textValue = formatDuration(value, $themeStore.language)
  }
</script>

<div class="flex-row-center gap-2">
  <EditBox
    {autoFocus}
    bind:value={textValue}
    placeholder={getEmbeddedLabel(hint)}
    maxWidth={'15rem'}
    kind={'editbox'}
    disabled={readonly}
  />
  {#if normalized !== '' && normalized !== textValue.trim()}
    <span class="text-sm content-dark-color">= {normalized}</span>
  {/if}
  {#if showQuickButtons}
    {#each [0.25, 0.5, 1, 2, 4, 8] as quickHours}
      <Button
        kind={'link-bordered'}
        disabled={readonly}
        on:click={() => {
          setDurationText(quickHours)
        }}
      >
        <span slot="content">{formatDuration(quickHours, $themeStore.language)}</span>
      </Button>
    {/each}
  {/if}
</div>
{#if isInvalid}
  <div class="text-sm" style="color: var(--theme-error-color);">
    <Label label={tracker.string.DurationParseError} params={{ format: hint }} />
  </div>
{/if}
