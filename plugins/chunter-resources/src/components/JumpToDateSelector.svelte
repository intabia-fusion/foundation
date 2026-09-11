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
  import { Timestamp } from '@hcengineering/core'
  import ui, { DateRangePopup, showPopup, themeStore } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import { translate } from '@hcengineering/platform'

  export let timestamp: Timestamp
  export let sticky: boolean = true

  let div: HTMLDivElement | undefined
  const dispatch = createEventDispatcher()

  async function formatDate (timestamp: Timestamp, lang: string): Promise<string> {
    const now = new Date()
    const date = new Date(timestamp)

    const dateStart = new Date(date).setHours(0, 0, 0, 0)
    const today = new Date(now).setHours(0, 0, 0, 0)

    if (dateStart === today) {
      return await translate(ui.string.Today, {}, lang)
    }

    const yesterdayDate = new Date(today)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)

    const yesterday = yesterdayDate.getTime()

    if (dateStart === yesterday) {
      return await translate(ui.string.Yesterday, {}, lang)
    } else {
      const dayOfWeek = new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(date)
      const dayMonth = new Intl.DateTimeFormat(lang, { day: '2-digit', month: 'long' }).format(date)

      return `${dayOfWeek} ${dayMonth}`
    }
  }
</script>

<div class="date-separator" class:sticky>
  <div
    class="date-separator__date border-radius-4 clear-mins"
    on:click={() => {
      showPopup(DateRangePopup, {}, div, (v) => {
        if (v != null) {
          v.setHours(0, 0, 0, 0)
          dispatch('jumpToDate', { date: v.getTime() })
        }
      })
    }}
  >
    {#await formatDate(timestamp, $themeStore.language) then date}
      {date}
    {/await}
  </div>
</div>

<div class="line" />

<style lang="scss">
  .date-separator {
    display: flex;
    width: 100%;
    padding: 0 1rem;
    font-size: 0.75rem;
    height: 2.25rem;
    position: relative;

    &.sticky {
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .date-separator__date {
      padding: 0.25rem 0.5rem;
      height: max-content;
      color: var(--theme-content-color);
      background-color: var(--highlight-select);
      border: 1px solid var(--highlight-select-border);
      font-weight: 500;
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: 0.25rem;
      min-height: 1.625rem;
      min-width: 3.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .line {
    flex: 1;
    height: 1px;
    min-height: 1px;
    width: 100%;
    background: var(--highlight-select-border);
    margin-top: -1.25rem;
    margin-bottom: 1rem;
  }
</style>
