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
  import {
    Button,
    ButtonMenu,
    getCurrentLocation,
    IconRedo,
    Label,
    location,
    navigate,
    Popup,
    Scroller,
    TabList,
    type TabItem
  } from '@hcengineering/ui'
  import { onDestroy } from 'svelte'

  import adminRes from '../plugin'
  import AccountsTab from './tabs/AccountsTab.svelte'
  import AuditTab from './tabs/AuditTab.svelte'
  import BillingTab from './tabs/BillingTab.svelte'
  import GeneralTab from './tabs/GeneralTab.svelte'
  import StatisticsTab from './tabs/StatisticsTab.svelte'
  import WorkspacesTab from './tabs/WorkspacesTab.svelte'
  import PaymentsTab from './tabs/PaymentsTab.svelte'

  let lastUpdated: number | undefined
  let refreshTick = 0

  function refresh (): void {
    refreshTick++
    lastUpdated = Date.now()
  }

  // Auto refresh, default 5 minutes
  let autoRefresh: string = '300'
  const refreshOptions = [
    { id: 'off', label: adminRes.string.RefreshOff },
    { id: '15', label: adminRes.string.Seconds15 },
    { id: '60', label: adminRes.string.Minute1 },
    { id: '300', label: adminRes.string.Minutes5 },
    { id: '900', label: adminRes.string.Minutes15 }
  ]

  let timer: ReturnType<typeof setInterval> | undefined
  $: {
    clearInterval(timer)
    const sec = parseInt(autoRefresh, 10)
    timer = isNaN(sec) ? undefined : setInterval(refresh, sec * 1000)
  }
  onDestroy(() => {
    clearInterval(timer)
  })

  refresh()

  const tabItems: TabItem[] = [
    { id: 'general', labelIntl: adminRes.string.General },
    { id: 'workspaces', labelIntl: adminRes.string.Workspaces },
    { id: 'accounts', labelIntl: adminRes.string.Accounts },
    { id: 'payments', labelIntl: adminRes.string.Payments },
    { id: 'statistics', labelIntl: adminRes.string.Statistics },
    { id: 'audit', labelIntl: adminRes.string.Audit },
    { id: 'billing', labelIntl: adminRes.string.AI }
  ]

  // Tab lives in the URL (/admin/<tab>) so it survives reload and is deep-linkable.
  $: selectedTab = tabItems.some((t) => t.id === $location.path[1]) ? $location.path[1] : 'general'

  function onTabSelect (ev: CustomEvent): void {
    if (ev.detail?.id !== undefined) {
      const loc = getCurrentLocation()
      loc.path[1] = ev.detail.id
      loc.path.length = 2
      navigate(loc)
    }
  }
</script>

<Scroller>
  <div class="flex-column flex-grow p-5">
    <div class="flex-row-center mb-4">
      <TabList items={tabItems} selected={selectedTab} on:select={onTabSelect} />
      <div class="flex-row-center ml-4">
        <Button icon={IconRedo} label={adminRes.string.Refresh} on:click={refresh} />
        <span class="ml-2 mr-1"><Label label={adminRes.string.AutoRefresh} />:</span>
        <ButtonMenu
          selected={autoRefresh}
          size={'small'}
          items={refreshOptions}
          label={refreshOptions.find((it) => it.id === autoRefresh)?.label}
          on:selected={(it) => {
            autoRefresh = it.detail
          }}
        />
        {#if lastUpdated !== undefined}
          <span class="ml-4 content-dark-color">
            <Label label={adminRes.string.UpdatedAt} />: {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        {/if}
      </div>
    </div>

    {#if selectedTab === 'general'}
      <GeneralTab {refreshTick} />
    {:else if selectedTab === 'workspaces'}
      <WorkspacesTab {refreshTick} />
    {:else if selectedTab === 'accounts'}
      <AccountsTab {refreshTick} />
    {:else if selectedTab === 'payments'}
      <PaymentsTab {refreshTick} />
    {:else if selectedTab === 'statistics'}
      <StatisticsTab {refreshTick} />
    {:else if selectedTab === 'audit'}
      <AuditTab {refreshTick} />
    {:else if selectedTab === 'billing'}
      <BillingTab />
    {/if}
  </div>
</Scroller>
<Popup />
