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
  import { getMetadata } from '@hcengineering/platform'
  import presentation from '@hcengineering/presentation'
  import { DropdownLabels, Expandable, ticker } from '@hcengineering/ui'
  import { FixedColumn } from '@hcengineering/view-resources'
  import { fetchStatsJson } from './statsFetch'

  interface AnalyticsEntry {
    service: string
    path: string
    operations: number
    total: number
    avg: number
    top: Array<{ value: number, time?: number, params?: Record<string, any> }>
  }

  interface AnalyticsResponse {
    entries: AnalyticsEntry[]
    generatedAt: number
    services: number
  }

  const endpoint = getMetadata(presentation.metadata.StatsUrl)
  const token: string = getMetadata(presentation.metadata.Token) ?? ''

  let sort: 'time' | 'count' | 'avg' = 'time'
  let source: 'all' | 'client' | 'server' = 'all'
  let limit: string = '100'
  let entries: AnalyticsEntry[] = []
  let services = 0
  let generatedAt = 0
  let error: string | undefined

  const sortItems = [
    { id: 'time', label: 'Total time' },
    { id: 'count', label: 'Operations count' },
    { id: 'avg', label: 'Avg time' }
  ]
  const sourceItems = [
    { id: 'all', label: 'All' },
    { id: 'server', label: 'Server' },
    { id: 'client', label: 'Client' }
  ]
  const limitItems = [
    { id: '50', label: '50' },
    { id: '100', label: '100' },
    { id: '500', label: '500' }
  ]

  let inflight: AbortController | undefined

  async function fetchTop (): Promise<void> {
    if (endpoint == null || token === '') return
    inflight?.abort()
    const ctrl = new AbortController()
    inflight = ctrl
    try {
      const url = `${endpoint}/api/v1/analytics?limit=${limit}&sort=${sort}&source=${source}`
      const data = await fetchStatsJson<AnalyticsResponse>(url, ctrl.signal)
      if (ctrl.signal.aborted) return
      entries = data.entries
      services = data.services
      generatedAt = data.generatedAt
      error = undefined
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      error = err?.message ?? String(err)
    } finally {
      if (inflight === ctrl) inflight = undefined
    }
  }

  // Refetch on tick or when the user changes any control. The template-string
  // dependency makes Svelte rerun the block whenever any value changes.
  $: if (`${$ticker}|${sort}|${source}|${limit}` !== '') {
    fetchTop().catch(() => {})
  }
</script>

<div class="flex-row-center p-1" style:gap="0.75rem" style:flex-wrap="wrap">
  <span>Sort:</span>
  <DropdownLabels bind:selected={sort} items={sortItems} />
  <span>Source:</span>
  <DropdownLabels bind:selected={source} items={sourceItems} />
  <span>Limit:</span>
  <DropdownLabels bind:selected={limit} items={limitItems} />
  {#if generatedAt > 0}
    <span class="greyed">services={services} updated={new Date(generatedAt).toLocaleTimeString()}</span>
  {/if}
</div>

{#if error}
  <div class="p-1" style:color="red">Error: {error}</div>
{/if}

<div class="flex-column p-3 h-full" style:overflow="auto">
  {#if entries.length === 0 && error === undefined}
    <div class="greyed p-2">No data yet.</div>
  {/if}
  {#each entries as e, i (i + e.service + e.path)}
    {@const expandable = e.top.length > 0}
    <Expandable bordered {expandable} showChevron={expandable} contentColor>
      <svelte:fragment slot="title">
        <div class="flex-row-center flex-between flex-grow ml-2">
          <span class="row-idx">{i + 1}.</span>
          <span class="row-svc">{e.service}</span>
          <span class="row-path select-text">{e.path}</span>
        </div>
      </svelte:fragment>
      <svelte:fragment slot="tools">
        <FixedColumn key="top-row">
          <div class="flex-row-center flex-between">
            <FixedColumn key="top-ops"><span class="p-1">{e.operations}</span></FixedColumn>
            <FixedColumn key="top-avg"><span class="p-1">{e.avg}</span></FixedColumn>
            <FixedColumn key="top-total"><span class="p-1">{e.total}</span></FixedColumn>
          </div>
        </FixedColumn>
      </svelte:fragment>
      {#if expandable}
        <div class="p-1 ml-2">
          {#each e.top as r}
            <Expandable>
              <svelte:fragment slot="title">
                <div class="flex-row-center flex-between flex-grow select-text">
                  Time: {r.value}{r.time !== undefined ? ` (sub: ${r.time})` : ''}
                </div>
              </svelte:fragment>
              <pre class="select-text">{JSON.stringify(r, null, 2)}</pre>
            </Expandable>
          {/each}
        </div>
      {/if}
    </Expandable>
  {/each}
</div>

<style lang="scss">
  .greyed {
    color: rgba(0, 0, 0, 0.5);
    margin-left: 0.5rem;
  }
  .row-idx {
    min-width: 2.5rem;
    color: rgba(0, 0, 0, 0.5);
  }
  .row-svc {
    min-width: 16rem;
    margin-right: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-path {
    flex: 1 1 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow-x: auto;
  }
</style>
