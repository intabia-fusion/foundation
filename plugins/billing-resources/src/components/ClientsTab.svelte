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
  import { Button, IconChevronLeft, IconChevronRight, Label, Loading } from '@hcengineering/ui'
  import type { AiTokensBreakdown, AiTranscriptBreakdown } from '@hcengineering/billing-client'
  import { getBillingClient } from '../utils'
  import plugin from '../plugin'
  import { formatMinutes, formatTokens } from '../billingFormat'

  let loading = true
  let yearOffset = 0

  const now = new Date()
  $: year = now.getFullYear() + yearOffset
  $: isCurrentYear = yearOffset >= 0

  const MONTHS = Array.from({ length: 12 }, (_, m) => m)
  const monthLabel = (m: number): string => new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'short' })

  interface Row {
    key: string
    label: string
    direct: boolean
    months: number[]
    total: number
  }

  let llmByWorker: Row[] = []
  let asrByWorker: Row[] = []
  let llmByLevel: Row[] = []
  let asrByLevel: Row[] = []

  // level id -> human label from the aibot model registry (LLM only; ASR shows the id).
  let levelLabels = new Map<string, string>()

  async function loadYear (y: number): Promise<void> {
    const client = getBillingClient()
    if (client === null) {
      loading = false
      return
    }
    loading = true
    try {
      const months = MONTHS.map((m) => ({ from: new Date(y, m, 1), to: new Date(y, m + 1, 1) }))

      const [registry, llmWorker, asrWorker, llmLevel, asrLevel] = await Promise.all([
        client.listAiModelRegistry(),
        Promise.all(months.map(({ from, to }) => client.getTokenUsage('client', undefined, from, to))),
        Promise.all(months.map(({ from, to }) => client.getTranscriptUsage('client', from, to))),
        Promise.all(months.map(({ from, to }) => client.getTokenUsage('level', undefined, from, to))),
        Promise.all(months.map(({ from, to }) => client.getTranscriptUsage('level', from, to)))
      ])

      levelLabels = new Map(registry.map((e) => [e.level, e.label]))

      llmByWorker = pivot(
        llmWorker,
        (r: AiTokensBreakdown) => r.clientId ?? '',
        (r) => r.rawTokens ?? r.totalTokens,
        false
      )
      asrByWorker = pivot(
        asrWorker,
        (r: AiTranscriptBreakdown) => r.clientId ?? '',
        (r) => r.durationSeconds / 60,
        false
      )
      llmByLevel = pivot(
        llmLevel,
        (r: AiTokensBreakdown) => r.level ?? '',
        (r) => r.rawTokens ?? r.totalTokens,
        true
      )
      asrByLevel = pivot(
        asrLevel,
        (r: AiTranscriptBreakdown) => r.level ?? '',
        (r) => r.durationSeconds / 60,
        true
      )
    } finally {
      loading = false
    }
  }

  // Build one row per distinct key with 12 monthly sums. `isLevel` maps the key to a label.
  function pivot<T> (byMonth: T[][], keyOf: (r: T) => string, valueOf: (r: T) => number, isLevel: boolean): Row[] {
    const map = new Map<string, number[]>()
    byMonth.forEach((rows, m) => {
      for (const r of rows) {
        const key = keyOf(r)
        let arr = map.get(key)
        if (arr === undefined) {
          arr = Array.from({ length: 12 }, () => 0)
          map.set(key, arr)
        }
        arr[m] += valueOf(r)
      }
    })
    return [...map.entries()]
      .map(([key, months]) => ({
        key,
        label: isLevel ? (levelLabels.get(key) ?? key) : key,
        direct: !isLevel && key === '',
        months,
        total: months.reduce((a, b) => a + b, 0)
      }))
      .sort((a, b) => b.total - a.total)
  }

  $: void loadYear(year)
</script>

<div class="flex-col flex-gap-4 p-4">
  <div class="flex-row-center flex-gap-2">
    <Button icon={IconChevronLeft} kind="ghost" on:click={() => (yearOffset -= 1)} />
    <span class="fs-title" style="min-width: 6rem; text-align: center">{year}</span>
    <Button icon={IconChevronRight} kind="ghost" disabled={isCurrentYear} on:click={() => (yearOffset += 1)} />
  </div>

  {#if loading}
    <Loading />
  {:else}
    <div class="tables-scroll flex-col flex-gap-2">
      {#each [{ title: plugin.string.SectionLLM, head: plugin.string.Workers, rows: llmByWorker, minutes: false }, { title: plugin.string.SectionLLM, head: plugin.string.ByLevel, rows: llmByLevel, minutes: false }, { title: plugin.string.SectionASR, head: plugin.string.Workers, rows: asrByWorker, minutes: true }, { title: plugin.string.SectionASR, head: plugin.string.ByLevel, rows: asrByLevel, minutes: true }] as tbl, ti (ti)}
        <div class="fs-title mt-2">
          <Label label={tbl.title} /> - <Label label={tbl.head} />
        </div>
        {#if tbl.rows.length === 0}
          <div class="content-dark-color text-sm"><Label label={plugin.string.NoData} /></div>
        {:else}
          <table>
            <colgroup>
              <col class="col-name" />
              {#each MONTHS as m (m)}<col class="col-month" />{/each}
              <col class="col-total" />
            </colgroup>
            <thead>
              <tr>
                <th class="left"><Label label={tbl.head} /></th>
                {#each MONTHS as m (m)}<th>{monthLabel(m)}</th>{/each}
                <th><Label label={plugin.string.Total} /></th>
              </tr>
            </thead>
            <tbody>
              {#each tbl.rows as row (row.key)}
                <tr>
                  <td class="left">
                    {#if row.direct}<Label label={plugin.string.DirectProvider} />{:else}{row.label}{/if}
                  </td>
                  {#each row.months as v, mi (mi)}
                    <td>{v > 0 ? (tbl.minutes ? formatMinutes(v) : formatTokens(v)) : ''}</td>
                  {/each}
                  <td class="strong">
                    {tbl.minutes ? formatMinutes(row.total) : formatTokens(row.total)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style lang="scss">
  .tables-scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: 0.8125rem;
    white-space: nowrap;
    // Fixed layout + shared column widths so all tables align as one grid with section gaps.
    table-layout: fixed;
    width: max-content;
  }
  .col-name {
    width: 12rem;
  }
  .col-month {
    width: 4rem;
  }
  .col-total {
    width: 6rem;
  }
  th,
  td {
    padding: 0.25rem 0.5rem;
    text-align: right;
    border-bottom: 1px solid var(--theme-divider-color);
  }
  th {
    color: var(--theme-dark-color);
    font-weight: 500;
  }
  .left {
    text-align: left;
    position: sticky;
    left: 0;
    background: var(--theme-list-row-color);
  }
  .strong {
    font-weight: 600;
  }
</style>
