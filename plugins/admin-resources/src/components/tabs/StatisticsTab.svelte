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
  import { adminFetch } from '../../utils'
  import { getMetadata } from '@hcengineering/platform'
  import presentation, { isAdminUser, type OverviewStatistics } from '@hcengineering/presentation'
  import { Button, Label, TabList, type TabItem } from '@hcengineering/ui'

  import adminRes from '../../plugin'
  import ServerManagerGeneral from '../statistics/ServerManagerGeneral.svelte'
  import ServerManagerServerStatistics from '../statistics/ServerManagerServerStatistics.svelte'
  import ServerManagerUsers from '../statistics/ServerManagerUsers.svelte'

  export let refreshTick: number = 0

  let subTab: string = 'services'
  const subTabs: TabItem[] = [
    { id: 'services', labelIntl: adminRes.string.Services },
    { id: 'live', labelIntl: adminRes.string.LiveStats },
    { id: 'users', labelIntl: adminRes.string.Users }
  ]

  // Live service stats (in-memory on the stats pod)
  const statsEndpoint = getMetadata(presentation.metadata.StatsUrl)
  let overview: OverviewStatistics | undefined

  async function loadOverview (): Promise<void> {
    try {
      const res = await adminFetch(statsEndpoint + '/api/v1/overview')
      overview = await res.json()
    } catch (err) {
      console.error(err)
    }
  }

  let prevTick = -1
  $: if (refreshTick !== prevTick) {
    prevTick = refreshTick
    void loadOverview()
  }

  $: services = Object.entries(overview?.data ?? {}).sort((a, b) => a[1].serviceName.localeCompare(b[1].serviceName))

  interface ServiceRow {
    name: string
    count: number
    memoryUsed: number
    memoryTotal: number
    memoryRSS: number
    cpu: number
  }

  let groupByName = true

  $: totals = services.reduce(
    (acc, [, svc]) => {
      acc.memoryUsed += svc.memory.memoryUsed
      acc.memoryTotal += svc.memory.memoryTotal
      acc.memoryRSS += svc.memory.memoryRSS
      acc.cpu += svc.cpu.usage
      return acc
    },
    { memoryUsed: 0, memoryTotal: 0, memoryRSS: 0, cpu: 0 }
  )

  $: serviceRows = ((): ServiceRow[] => {
    if (!groupByName) {
      return services.map(([id, svc]) => ({
        name: `${svc.serviceName} - ${id}`,
        count: 1,
        memoryUsed: svc.memory.memoryUsed,
        memoryTotal: svc.memory.memoryTotal,
        memoryRSS: svc.memory.memoryRSS,
        cpu: svc.cpu.usage
      }))
    }
    const byName = new Map<string, ServiceRow>()
    for (const [, svc] of services) {
      const row = byName.get(svc.serviceName) ?? {
        name: svc.serviceName,
        count: 0,
        memoryUsed: 0,
        memoryTotal: 0,
        memoryRSS: 0,
        cpu: 0
      }
      row.count++
      row.memoryUsed += svc.memory.memoryUsed
      row.memoryTotal += svc.memory.memoryTotal
      row.memoryRSS += svc.memory.memoryRSS
      row.cpu += svc.cpu.usage
      byName.set(svc.serviceName, row)
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  })()
</script>

<div class="p-3">
  <TabList
    items={subTabs}
    selected={subTab}
    on:select={(ev) => {
      if (ev.detail !== undefined) subTab = ev.detail.id
    }}
  />
</div>

{#if subTab === 'services'}
  <div class="p-3 columns">
    <div class="column">
      <div class="flex-row-center mb-2">
        <span class="fs-title mr-4"><Label label={adminRes.string.Services} /></span>
        <Button
          label={adminRes.string.GroupByName}
          kind={groupByName ? 'primary' : 'regular'}
          size={'small'}
          on:click={() => (groupByName = !groupByName)}
        />
      </div>
      <div class="mb-2 content-dark-color">
        <Label label={adminRes.string.Total} />: mem {Math.round(totals.memoryUsed)}/{Math.round(totals.memoryTotal)} MB,
        RSS {Math.round(totals.memoryRSS)}
        MB, CPU {Math.round(totals.cpu * 10) / 10}%
      </div>
      <table class="services-table">
        <thead>
          <tr>
            <th><Label label={adminRes.string.Service} /></th>
            <th>Mem (MB)</th>
            <th>RSS (MB)</th>
            <th>CPU (%)</th>
          </tr>
        </thead>
        <tbody>
          {#each serviceRows as row}
            <tr>
              <td>{row.name}{row.count > 1 ? ` x${row.count}` : ''}</td>
              <td>{Math.round(row.memoryUsed)}/{Math.round(row.memoryTotal)}</td>
              <td>{Math.round(row.memoryRSS)}</td>
              <td>{Math.round(row.cpu * 10) / 10}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if isAdminUser()}
      <div class="column">
        <div class="fs-title mb-2"><Label label={adminRes.string.ServerManager} /></div>
        <ServerManagerGeneral />
      </div>
    {/if}
  </div>
{:else if subTab === 'live'}
  <ServerManagerServerStatistics />
{:else if subTab === 'users'}
  <ServerManagerUsers />
{/if}

<style lang="scss">
  .columns {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
    .column {
      flex: 1 1 30rem;
      min-width: 0;
    }
  }
  .services-table {
    border-collapse: collapse;
    width: 100%;
    th,
    td {
      text-align: left;
      padding: 0.25rem 1rem 0.25rem 0;
      border-bottom: 1px solid var(--theme-divider-color, #8883);
    }
  }
</style>
