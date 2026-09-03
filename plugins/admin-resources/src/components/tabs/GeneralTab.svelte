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
  import type { WorkspacesSummary } from '@hcengineering/account-client'
  import { reduceCalls } from '@hcengineering/core'
  import { getEmbeddedLabel, getMetadata } from '@hcengineering/platform'
  import presentation, { type OverviewStatistics } from '@hcengineering/presentation'
  import { Button, ButtonMenu, Label, themeStore } from '@hcengineering/ui'

  import adminRes from '../../plugin'
  import RegistrationsChart from '../RegistrationsChart.svelte'
  import { downloadReport, type ReportFormat, type ReportId } from '../../reports'
  import { getWorkspacesSummary, loadPlanOptions, type PlanOptions, adminFetch } from '../../utils'

  let generating = false
  let reportFormat: ReportFormat = 'csv'
  const reportItems = [
    { id: 'accounts', label: adminRes.string.ReportAccounts },
    { id: 'workspaces', label: adminRes.string.ReportWorkspaces },
    { id: 'paid', label: adminRes.string.ReportPaidWorkspaces }
  ]
  async function runReport (id: ReportId): Promise<void> {
    generating = true
    try {
      await downloadReport(id, reportFormat)
    } catch (err) {
      console.error('Report generation failed:', err)
    } finally {
      generating = false
    }
  }

  export let refreshTick: number = 0

  let summary: WorkspacesSummary | null = null

  const loadSummary = reduceCalls(async (): Promise<void> => {
    summary = await getWorkspacesSummary()
  })

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

  let plans: PlanOptions | null = null
  void loadPlanOptions($themeStore.language ?? 'en').then((p) => {
    plans = p
  })

  let prevTick = -1
  $: if (refreshTick !== prevTick) {
    prevTick = refreshTick
    void loadSummary()
    void loadOverview()
  }

  $: billing = summary?.billing ?? []
  $: paidSeats = billing
    .filter((b) => plans?.config?.plans?.[b.plan]?.free !== true)
    .reduce((acc, b) => acc + b.seats, 0)
</script>

<div class="p-3">
  <div class="flex-row-center mb-2">
    <span class="fs-title mr-4"><Label label={adminRes.string.Reports} /></span>
    <ButtonMenu
      label={adminRes.string.CreateReport}
      kind={'primary'}
      size={'small'}
      disabled={generating}
      items={reportItems}
      on:selected={(it) => {
        void runReport(it.detail)
      }}
    />
    <div class="ml-2 flex-row-center">
      <Button
        label={getEmbeddedLabel('CSV')}
        kind={reportFormat === 'csv' ? 'primary' : 'regular'}
        size={'small'}
        on:click={() => (reportFormat = 'csv')}
      />
      <Button
        label={getEmbeddedLabel('PDF')}
        kind={reportFormat === 'pdf' ? 'primary' : 'regular'}
        size={'small'}
        on:click={() => (reportFormat = 'pdf')}
      />
    </div>
  </div>

  <div class="fs-title mb-2"><Label label={adminRes.string.Workspaces} /></div>
  <div class="flex-row-center flex-wrap">
    <span class="mr-4"><Label label={adminRes.string.Total} />: {summary?.total ?? '-'}</span>
    {#each Object.entries(summary?.byMode ?? {}) as [mode, count]}
      <span class="mr-4">{mode}: {count}</span>
    {/each}
  </div>
  <div class="flex-row-center flex-wrap mt-1">
    {#each Object.entries(summary?.byVersion ?? {}) as [k, v]}
      <span class="mr-4">{k}: {v}</span>
    {/each}
    {#each Object.entries(summary?.byRegion ?? {}) as [k, v]}
      <span class="mr-4">{k === '' ? 'Default' : k}: {v}</span>
    {/each}
  </div>

  <div class="fs-title mt-4 mb-2"><Label label={adminRes.string.LiveStats} /></div>
  <div class="flex-row-center">
    <span class="mr-4"><Label label={adminRes.string.Users} />: {overview?.usersTotal ?? '-'}</span>
    <span class="mr-4"><Label label={adminRes.string.Connections} />: {overview?.connectionsTotal ?? '-'}</span>
    <span class="mr-4"><Label label={adminRes.string.ActiveWorkspaces} />: {overview?.workspaces?.length ?? '-'}</span>
  </div>

  <div class="fs-title mt-4 mb-2"><Label label={adminRes.string.PaidSeats} /></div>
  <div class="flex-row-center flex-wrap">
    <span class="mr-4"><Label label={adminRes.string.Total} />: {paidSeats}</span>
    {#each billing as b}
      <span class="mr-4">
        {plans?.labels[b.plan] ?? b.plan}: {b.seats}
        <span class="content-dark-color">({b.workspaces} ws)</span>
      </span>
    {/each}
  </div>
</div>

<RegistrationsChart {refreshTick} />
