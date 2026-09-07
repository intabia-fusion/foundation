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
  import { type Timestamp } from '@hcengineering/core'
  import { MILLISECONDS_IN_MINUTE, tooltip } from '@hcengineering/ui'
  import time from '../../../plugin'

  // Coarse busy interval of another person, without any event content.
  // Named `busySlot`, not `slot` - the latter is reserved by Svelte for named-slot projection.
  export let busySlot: { date: Timestamp, dueDate: Timestamp }
  export let hour: number
  export let top: number

  $: width = (hour * (busySlot.dueDate - busySlot.date)) / MILLISECONDS_IN_MINUTE / 60
  $: left = (hour / 60) * new Date(busySlot.date).getMinutes()
</script>

<div
  class="busy-container"
  style:width="{width}rem"
  style:margin-left="{left}rem"
  style:margin-top="{-3 * top}rem"
  use:tooltip={{ label: time.string.Busy }}
/>

<style lang="scss">
  .busy-container {
    pointer-events: auto;
    overflow: hidden;
    height: 3rem;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.25rem;
    cursor: default;
    background-image: repeating-linear-gradient(
      45deg,
      var(--theme-divider-color),
      var(--theme-divider-color) 4px,
      transparent 4px,
      transparent 8px
    );
    background-color: var(--theme-bg-accent-color);
  }
</style>
