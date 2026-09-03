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
  import { type RegionInfo, WorkspacesSortKey } from '@hcengineering/account-client'
  import {
    groupByArray,
    isActiveMode,
    isArchivingMode,
    isDeletingMode,
    reduceCalls,
    systemAccountUuid,
    type WorkspaceMode,
    WorkspaceUserOperation
  } from '@hcengineering/core'
  import { getEmbeddedLabel, getMetadata, type IntlString, translate } from '@hcengineering/platform'
  import presentation, {
    copyTextToClipboard,
    isAdminUser,
    isBillingAdminUser,
    MessageBox,
    type OverviewStatistics,
    type WorkspaceStatistics
  } from '@hcengineering/presentation'
  import {
    Button,
    ButtonMenu,
    CheckBox,
    IconArrowRight,
    IconCopy,
    IconDetails,
    IconDownOutline,
    IconOpen,
    IconStart,
    IconStop,
    Label,
    locationToUrl,
    Scroller,
    SearchEdit,
    showPopup,
    themeStore,
    ticker
  } from '@hcengineering/ui'
  import { workbenchId } from '@hcengineering/workbench'
  import { formatMinutes } from '@hcengineering/billing-resources'
  import { onDestroy, onMount } from 'svelte'

  import adminRes from '../../plugin'
  import CreateWorkspaceDialog from '../CreateWorkspaceDialog.svelte'
  import WorkspaceDetails from '../WorkspaceDetails.svelte'
  import {
    getAccountClient,
    getBillingClient,
    getRegionInfo,
    listWorkspacesPaged,
    loadPlanOptions,
    performWorkspaceOperationWithOtp,
    requestAdminOtpCode,
    type PlanOptions,
    type WorkspaceInfo,
    adminFetch
  } from '../../utils'

  export let refreshTick: number = 0

  // Read-only billing admin: hide all mutating controls (server also rejects).
  const readOnly = isBillingAdminUser() && !isAdminUser()

  $: now = $ticker

  let search: string = ''

  async function select (workspace: string): Promise<void> {
    const url = locationToUrl({ path: [workbenchId, workspace] })
    window.open(url, '_blank')
  }

  // Every workspace operation requires an emailed OTP code; ask before running.
  async function otpGuardedOp (ws: string | string[], event: WorkspaceUserOperation, ...params: any[]): Promise<void> {
    const code = await requestAdminOtpCode()
    if (code === undefined) return
    await performWorkspaceOperationWithOtp(ws, event, code, ...params)
  }

  enum SortingRule {
    Activity = '1',
    Name = '2',
    BackupDate = '3',
    BackupSize = '4',
    LastVisit = '5',
    Tokens = '6',
    Minutes = '7',
    Members = '8'
  }

  let sortingRule = SortingRule.LastVisit
  let sortAsc = false

  // Names read best A-Z, every other column starts from the biggest/most recent.
  function sortBy (rule: SortingRule): void {
    if (sortingRule === rule) {
      sortAsc = !sortAsc
      return
    }
    sortingRule = rule
    sortAsc = rule === SortingRule.Name
  }

  // Reactive on purpose: a plain function called with a constant argument would never be
  // re-evaluated, so every marker but the initial one stayed empty.
  $: sortMark = (rule: SortingRule): string => (sortingRule === rule ? (sortAsc ? ' ↑' : ' ↓') : '')
  $: ariaSort = (rule: SortingRule): 'ascending' | 'descending' | 'none' =>
    sortingRule === rule ? (sortAsc ? 'ascending' : 'descending') : 'none'

  function sortOnKey (e: KeyboardEvent, rule: SortingRule): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      sortBy(rule)
    }
  }

  // Activity sorts the current page by live stats; the rest are server-side
  const serverSort: Record<SortingRule, WorkspacesSortKey | undefined> = {
    [SortingRule.Activity]: undefined,
    [SortingRule.Name]: 'name',
    [SortingRule.BackupDate]: 'backupDate',
    [SortingRule.BackupSize]: 'backupSize',
    [SortingRule.LastVisit]: 'lastVisit',
    [SortingRule.Tokens]: undefined,
    [SortingRule.Minutes]: undefined,
    [SortingRule.Members]: undefined
  }

  // Individual filters

  let showActive: boolean = true
  let showArchived: boolean = false
  let showDeleted: boolean = false
  let showOther: boolean = true
  let showGrAttempts: boolean = false
  let showSelectedRegionOnly: boolean = false
  let showInactive = false

  let superAdminMode = false

  const archivedModes: WorkspaceMode[] = [
    'archiving-pending-backup',
    'archiving-backup',
    'archiving-pending-clean',
    'archiving-clean',
    'archived'
  ]
  const deletedModes: WorkspaceMode[] = ['pending-deletion', 'deleting', 'deleted']
  const otherModes: WorkspaceMode[] = [
    'manual-creation',
    'pending-creation',
    'creating',
    'upgrading',
    'migration-pending-backup',
    'migration-backup',
    'migration-pending-clean',
    'migration-clean',
    'pending-restore',
    'restoring'
  ]

  $: modes = [
    ...(showActive ? (['active'] as WorkspaceMode[]) : []),
    ...(showArchived ? archivedModes : []),
    ...(showDeleted ? deletedModes : []),
    ...(showOther ? otherModes : [])
  ]

  // Server-side paging
  let workspaces: WorkspaceInfo[] = []
  let total = 0
  let pageSkip = 0
  const pageLimit = 50

  let searchDebounced = ''
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  $: {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchDebounced = search.trim()
    }, 300)
  }
  onDestroy(() => {
    clearTimeout(searchTimer)
  })

  // Billing filters
  let billingPlanFilter = ''
  let showBillingExpired = false
  let showTrialingOnly = false
  // Paid-only view of a tier: 'business' plus this gives Business without the trials.
  let excludeTrialing = false
  let plans: PlanOptions | null = null
  void loadPlanOptions($themeStore.language ?? 'en').then((p) => {
    plans = p
  })

  let loadFailed = false

  // Best-effort: billing may be unconfigured in the admin panel, columns just stay empty then.
  let aiTokensByWs = new Map<string, number>()
  let asrMinutesByWs = new Map<string, number>()

  async function loadBillingUsage (): Promise<void> {
    const billingClient = getBillingClient()
    if (billingClient === null) return
    try {
      const [breakdown, transcript] = await Promise.all([
        billingClient.getWorkspaceBreakdown(1000, 0),
        billingClient.getTranscriptUsage('workspace')
      ])
      aiTokensByWs = new Map(breakdown.map((it) => [it.workspace, it.usedRolling30d]))
      asrMinutesByWs = new Map(transcript.map((it) => [it.workspace ?? '', (it.durationSeconds ?? 0) / 60]))
    } catch (err) {
      console.error(err)
    }
  }

  onMount(() => {
    void loadBillingUsage()
  })

  const loadPage = reduceCalls(async (): Promise<void> => {
    const res = await listWorkspacesPaged({
      search: searchDebounced.length > 0 ? searchDebounced : undefined,
      modes: modes.length > 0 ? modes : undefined,
      region: showSelectedRegionOnly ? filterRegionId : undefined,
      attemptsGte: showGrAttempts ? 1 : undefined,
      billingPlan: billingPlanFilter !== '' ? billingPlanFilter : undefined,
      billingStatus: showTrialingOnly ? 'trialing' : undefined,
      billingStatusNot: excludeTrialing ? 'trialing' : undefined,
      billingExpired: showBillingExpired ? true : undefined,
      sort: serverSort[sortingRule] ?? 'lastVisit',
      order: sortAsc ? 'asc' : 'desc',
      skip: pageSkip,
      limit: pageLimit
    })
    loadFailed = res == null
    if (res != null) {
      workspaces = res.workspaces as WorkspaceInfo[]
      total = res.total
    }
  })

  $: queryKey = JSON.stringify({
    searchDebounced,
    sortingRule,
    sortAsc,
    modes,
    region: showSelectedRegionOnly ? filterRegionId : null,
    attempts: showGrAttempts,
    billingPlanFilter,
    showTrialingOnly,
    excludeTrialing,
    showBillingExpired
  })
  let prevQueryKey = ''
  $: if (queryKey !== prevQueryKey) {
    prevQueryKey = queryKey
    pageSkip = 0
    void loadPage()
  }
  let prevSkip = 0
  $: if (pageSkip !== prevSkip) {
    prevSkip = pageSkip
    void loadPage()
  }
  let prevTick = -1
  $: if (refreshTick !== prevTick) {
    prevTick = refreshTick
    void loadPage()
  }

  // Group expand state survives page reloads/refresh (keyed by dayRanges group)
  // Undefined means "never touched" and renders open; only an explicit false collapses a group.
  const expandedGroups: Record<string, boolean | undefined> = {}
  $: if (searchDebounced.length > 0) {
    for (const k of Object.keys(dayRanges)) expandedGroups[k] = true
  }

  function isWorkspaceInactive (it: WorkspaceInfo, stats: WorkspaceStatistics | undefined): boolean {
    if (stats === undefined) {
      return true
    }
    const ops = (stats.sessions ?? []).reduceRight(
      (p, it) => p + (it.mins5.tx + it.mins5.find) + (it.current.tx + it.current.find),
      0
    )
    if (ops === 0) {
      return true
    }
    if (stats.sessions.filter((it) => (it.userId as any) !== systemAccountUuid).length === 0) {
      return true
    }
    return false
  }

  // Server returns the page filtered/sorted; page-local: inactive filter (live stats) and Activity/Tokens/Minutes sort
  $: sortedWorkspaces = workspaces
    .filter((it) => (showInactive ? isWorkspaceInactive(it, statsByWorkspace.get(it.uuid)) : true))
    .sort((a, b) => {
      const dir = sortAsc ? -1 : 1
      if (sortingRule === SortingRule.Activity) {
        const aStats = statsByWorkspace.get(a.uuid ?? '')
        const bStats = statsByWorkspace.get(b.uuid ?? '')
        return ((bStats?.sessions?.length ?? 0) - (aStats?.sessions?.length ?? 0)) * dir
      }
      if (sortingRule === SortingRule.Tokens) {
        return ((aiTokensByWs.get(b.uuid ?? '') ?? 0) - (aiTokensByWs.get(a.uuid ?? '') ?? 0)) * dir
      }
      if (sortingRule === SortingRule.Minutes) {
        return ((asrMinutesByWs.get(b.uuid ?? '') ?? 0) - (asrMinutesByWs.get(a.uuid ?? '') ?? 0)) * dir
      }
      if (sortingRule === SortingRule.Members) {
        return ((b.usageInfo?.usage.membersCount ?? 0) - (a.usageInfo?.usage.membersCount ?? 0)) * dir
      }
      return 0
    })

  let backupIdx = new Map<string, number>()

  const backupInterval: number = 43200

  let backupable: WorkspaceInfo[] = []

  const endpoint = getMetadata(presentation.metadata.StatsUrl)

  async function fetchStats (time: number): Promise<void> {
    await adminFetch(endpoint + '/api/v1/overview')
      .then(async (json) => {
        data = await json.json()
      })
      .catch((err) => {
        console.error(err)
      })
  }
  let data: OverviewStatistics | undefined
  $: void fetchStats($ticker)

  $: statsByWorkspace = new Map((data?.workspaces ?? []).map((it) => [it.wsId, it]))

  $: {
    // Assign backup idx
    const backupSorting = [...workspaces].filter((it) => {
      if (!isActiveMode(it.mode)) {
        return false
      }
      const lastBackup = it.backupInfo?.lastBackup ?? 0
      if ((now - lastBackup) / 1000 < backupInterval) {
        // No backup required, interval not elapsed
        return false
      }

      const createdOn = Math.floor((now - it.createdOn) / 1000)
      if (createdOn <= 2) {
        // Skip if we created is less 2 days
        return false
      }
      if (it.lastVisit == null) {
        return false
      }

      const lastVisitSec = Math.floor((now - it.lastVisit) / 1000)
      if (lastVisitSec > backupInterval) {
        // No backup required, interval not elapsed
        return false
      }
      return true
    })
    const newBackupIdx = new Map<string, number>()

    backupSorting.sort((a, b) => {
      return (a.backupInfo?.lastBackup ?? 0) - (b.backupInfo?.lastBackup ?? 0)
    })

    // Shift new with existing ones.
    const existingNew = groupByArray(backupSorting, (it) => it.backupInfo != null)

    const existing = existingNew.get(true) ?? []
    const newOnes = existingNew.get(false) ?? []
    const mixedBackupSorting: WorkspaceInfo[] = []

    while (existing.length > 0 || newOnes.length > 0) {
      const e = existing.shift()
      const n = newOnes.shift()
      if (e != null) {
        mixedBackupSorting.push(e)
      }
      if (n != null) {
        mixedBackupSorting.push(n)
      }
    }

    backupable = mixedBackupSorting

    for (const [idx, it] of mixedBackupSorting.entries()) {
      newBackupIdx.set(it.uuid, idx)
    }
    backupIdx = newBackupIdx
  }

  // Buckets by time since the last visit; the last one collects everything older.
  const dayRanges = {
    '< 1d': [-1, 1],
    '< 3d': [1, 3],
    '< 7d': [3, 7],
    '< 1m': [7, 30],
    '< 3m': [30, 90],
    '> 3m': [90, 10000000]
  }

  let limit = 50

  // Buckets make sense only while the list is ordered by last visit; any other sort would be
  // invisible inside them, so it switches to one flat group.
  $: byLastVisit = sortingRule === SortingRule.LastVisit
  $: groupped = byLastVisit
    ? groupByArray(sortedWorkspaces, (it) => {
      const lastUsageDays = Math.round((10 * (now - (it.lastVisit ?? 0))) / (1000 * 3600 * 24)) / 10
      return Object.entries(dayRanges).find(([_k, v]) => v[0] < lastUsageDays && lastUsageDays <= v[1])?.[0] ?? '> 3m'
    })
    : new Map([['', sortedWorkspaces]])
  $: groupKeys = byLastVisit ? Object.keys(dayRanges) : ['']

  let regionInfo: RegionInfo[] = []

  let regionTitles: Record<string, string> = {}

  let selectedRegionId: string = ''

  let filterRegionId: string = ''

  void getRegionInfo().then((_regionInfo) => {
    regionInfo = _regionInfo ?? []
    regionTitles = Object.fromEntries(
      regionInfo.map((it) => [it.region, it.name.length !== 0 ? it.name : it.region.length > 0 ? it.region : 'Default'])
    )
    if (selectedRegionId === '' && regionInfo.length > 0) {
      selectedRegionId = regionInfo[0].region
    }
    if (filterRegionId === '' && regionInfo.length > 0) {
      filterRegionId = regionInfo[0].region
    }
  })

  $: selectedRegionRef = regionInfo.find((it) => it.region === selectedRegionId)
  $: selectedRegionName =
    selectedRegionRef !== undefined
      ? selectedRegionRef.name.length > 0
        ? selectedRegionRef.name
        : selectedRegionRef.region
      : ''

  $: filteredRegionRef = regionInfo.find((it) => it.region === filterRegionId)
  $: filteredRegionName =
    filteredRegionRef !== undefined
      ? filteredRegionRef.name.length > 0
        ? filteredRegionRef.name
        : filteredRegionRef.region
      : ''

  function fmtTokens (n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return `${n}`
  }
</script>

<div class="anticrm-panel flex-row flex-grow" style:overflow-y={'auto'}>
  <div class="flex-between">
    <div class="fs-title p-3"><Label label={adminRes.string.WorkspacesAdminTitle} /></div>
    <div class="flex-row-center">
      {#if !readOnly}
        <Button
          label={adminRes.string.CreateWorkspace}
          kind={'primary'}
          size={'small'}
          on:click={() => {
            showPopup(CreateWorkspaceDialog, {}, undefined, (created) => {
              if (created === true) void loadPage()
            })
          }}
        />
      {/if}
      {#if !readOnly}
        <div class="ml-2 mr-4">
          <Button
            label={adminRes.string.ReindexAll}
            size={'small'}
            on:click={() => {
              void requestAdminOtpCode().then(async (code) => {
                if (code === undefined) return
                await getAccountClient().adminReindexAllWorkspaces(code)
              })
            }}
          />
        </div>
      {/if}
      <span class="mr-4"><Label label={adminRes.string.EnableDeletion} /></span>
      <CheckBox bind:checked={superAdminMode} />
    </div>
  </div>
  <div class="fs-title p-3 flex-no-shrink" data-testid="workspace-search-container">
    <SearchEdit bind:value={search} width={'100%'} />
  </div>

  {#if loadFailed}
    <div class="p-3 error-color"><Label label={adminRes.string.LoadError} /></div>
  {/if}

  <div class="p-3 flex-row-center flex-wrap filters-row">
    <Button
      label={adminRes.string.Previous}
      size={'small'}
      disabled={pageSkip === 0}
      on:click={() => {
        pageSkip = Math.max(0, pageSkip - pageLimit)
      }}
    />
    <span class="mx-1">
      {Math.floor(pageSkip / pageLimit) + 1} / {Math.max(1, Math.ceil(total / pageLimit))} ({total})
    </span>
    <Button
      label={adminRes.string.Next}
      size={'small'}
      disabled={pageSkip + pageLimit >= total}
      on:click={() => {
        pageSkip += pageLimit
      }}
    />

    <span class="ml-4 mr-1"><Label label={adminRes.string.ShowActive} /></span>
    <CheckBox bind:checked={showActive} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.ShowArchived} /></span>
    <CheckBox bind:checked={showArchived} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.ShowDeleted} /></span>
    <CheckBox bind:checked={showDeleted} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.ShowOther} /></span>
    <CheckBox bind:checked={showOther} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.ShowAttempts} /></span>
    <CheckBox bind:checked={showGrAttempts} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.ShowInactive} /></span>
    <CheckBox bind:checked={showInactive} />
  </div>

  <div class="p-3 flex-row-center flex-wrap filters-row">
    <span class="mr-1"><Label label={adminRes.string.MigrationRegion} /></span>
    <ButtonMenu
      selected={selectedRegionId}
      autoSelectionIfOne
      title={selectedRegionName}
      items={regionInfo.map((it) => ({
        id: it.region === '' ? '#' : it.region,
        label: getEmbeddedLabel(it.name.length > 0 ? it.name : it.region + ' (hidden)')
      }))}
      on:selected={(it) => {
        selectedRegionId = it.detail === '#' ? '' : it.detail
      }}
    />

    <span class="ml-4 mr-1"><CheckBox bind:checked={showSelectedRegionOnly} /></span>
    <span class="mr-1"><Label label={adminRes.string.FilterRegion} /></span>
    <ButtonMenu
      selected={filterRegionId}
      autoSelectionIfOne
      title={filteredRegionName}
      items={regionInfo.map((it) => ({
        id: it.region === '' ? '#' : it.region,
        label: getEmbeddedLabel(it.name.length > 0 ? it.name : it.region + ' (hidden)')
      }))}
      on:selected={(it) => {
        filterRegionId = it.detail === '#' ? '' : it.detail
      }}
    />

    <span class="ml-4 mr-1"><Label label={adminRes.string.Plan} /></span>
    <ButtonMenu
      selected={billingPlanFilter === '' ? '#' : billingPlanFilter}
      label={billingPlanFilter === '' ? adminRes.string.AllPlans : undefined}
      title={billingPlanFilter === '' ? undefined : (plans?.labels[billingPlanFilter] ?? billingPlanFilter)}
      items={[
        { id: '#', label: adminRes.string.AllPlans },
        ...(plans?.keys ?? []).map((k) => ({ id: k, label: getEmbeddedLabel(`${plans?.labels[k] ?? k} (${k})`) }))
      ]}
      on:selected={(it) => {
        billingPlanFilter = it.detail === '#' ? '' : it.detail
      }}
    />
    <span class="ml-3 mr-1"><Label label={adminRes.string.TrialingOnly} /></span>
    <CheckBox bind:checked={showTrialingOnly} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.NoTrial} /></span>
    <CheckBox bind:checked={excludeTrialing} />
    <span class="ml-3 mr-1"><Label label={adminRes.string.BillingExpired} /></span>
    <CheckBox bind:checked={showBillingExpired} />
  </div>
  <div class="p-1 select-text-i">
    <div class="table-scroll">
      <table class="workspaces-table">
        <thead>
          <tr>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.Name}
              aria-sort={ariaSort(SortingRule.Name)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.Name)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.Name)
              }}
            >
              <Label label={adminRes.string.Workspace} />{sortMark(SortingRule.Name)}
            </th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.Activity}
              aria-sort={ariaSort(SortingRule.Activity)}
              tabindex="0"
              title="Open sessions right now"
              on:click={() => {
                sortBy(SortingRule.Activity)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.Activity)
              }}
            >
              <Label label={adminRes.string.Sessions} />{sortMark(SortingRule.Activity)}
            </th>
            <th title="Transactions and queries served in the last 5 minutes">
              <Label label={adminRes.string.Ops5m} />
            </th>
            <th><Label label={adminRes.string.Region} /></th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.LastVisit}
              aria-sort={ariaSort(SortingRule.LastVisit)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.LastVisit)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.LastVisit)
              }}
            >
              <Label label={adminRes.string.LastVisit} />{sortMark(SortingRule.LastVisit)}
            </th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.Members}
              aria-sort={ariaSort(SortingRule.Members)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.Members)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.Members)
              }}
            >
              <Label label={adminRes.string.Members} />{sortMark(SortingRule.Members)}
            </th>
            <th><Label label={adminRes.string.Mode} /></th>
            <th><Label label={adminRes.string.Plan} /></th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.Tokens}
              aria-sort={ariaSort(SortingRule.Tokens)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.Tokens)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.Tokens)
              }}
            >
              <Label label={adminRes.string.AITokens} />{sortMark(SortingRule.Tokens)}
            </th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.Minutes}
              aria-sort={ariaSort(SortingRule.Minutes)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.Minutes)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.Minutes)
              }}
            >
              <Label label={adminRes.string.MeetingMinutes} />{sortMark(SortingRule.Minutes)}
            </th>
            <th><Label label={adminRes.string.Attempts} /></th>
            <th><Label label={adminRes.string.Progress} /></th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.BackupSize}
              aria-sort={ariaSort(SortingRule.BackupSize)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.BackupSize)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.BackupSize)
              }}
            >
              <Label label={adminRes.string.SortBackupSize} />{sortMark(SortingRule.BackupSize)}
            </th>
            <th
              class="sortable"
              class:sorted={sortingRule === SortingRule.BackupDate}
              aria-sort={ariaSort(SortingRule.BackupDate)}
              tabindex="0"
              on:click={() => {
                sortBy(SortingRule.BackupDate)
              }}
              on:keydown={(e) => {
                sortOnKey(e, SortingRule.BackupDate)
              }}
            >
              <Label label={adminRes.string.LastBackup} />{sortMark(SortingRule.BackupDate)}
            </th>
            <th><Label label={adminRes.string.Actions} /></th>
          </tr>
        </thead>
        <tbody>
          {#each groupKeys as k}
            {@const v = groupped.get(k) ?? []}
            {@const hasMore = v.length > limit}
            {@const activeV = v.filter((it) => isActiveMode(it.mode) && it.region !== selectedRegionId).slice(0, limit)}
            {@const activeAll = v.filter((it) => isActiveMode(it.mode))}
            {@const archivedV = v.filter((it) => isArchivingMode(it.mode))}
            {@const deletedV = v.filter((it) => isDeletingMode(it.mode))}
            {@const maintenance = v.length - activeAll.length - archivedV.length - deletedV.length}
            {@const grByRegion = groupByArray(v, (it) => regionTitles[it.region ?? ''])}
            {@const expanded = expandedGroups[k] !== false}
            {#if v.length > 0}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <tr class="group-row cursor-pointer" on:click={() => (expandedGroups[k] = !expanded)}>
                <td colspan="15">
                  <div class="flex-row-center flex-gap-2">
                    <span class="fs-title">
                      {expanded ? '▾' : '▸'}
                      {#if k !== ''}
                        {k}
                      {:else}
                        <Label label={adminRes.string.Total} />
                      {/if}
                      -
                      {#if hasMore}
                        {limit} of {v.length}
                      {:else}
                        {v.length}
                      {/if}
                    </span>
                    {#if maintenance > 0}
                      <span class="content-dark-color">maintenance: {maintenance}</span>
                    {/if}
                    {#if grByRegion.size > 1}
                      {#each grByRegion.entries() as [region, list]}
                        <span class="content-dark-color">{region ?? ''}: {list.length}</span>
                      {/each}
                    {/if}
                    <div class="flex-grow" />
                    {#if hasMore}
                      <Button
                        label={adminRes.string.MoreItems}
                        kind={'link'}
                        on:click={(ev) => {
                          ev.stopPropagation()
                          limit += 50
                        }}
                      />
                    {/if}
                    {#if !readOnly && activeAll.length > 0}
                      <Button
                        icon={IconStop}
                        label={adminRes.string.MassArchive}
                        labelParams={{ count: activeAll.length }}
                        kind={'ghost'}
                        on:click={(ev) => {
                          ev.stopPropagation()
                          void otpGuardedOp(
                            activeAll.map((it) => it.uuid),
                            'archive'
                          ).then(() => {
                            void loadPage()
                          })
                        }}
                      />
                    {/if}
                    {#if !readOnly && regionInfo.length > 0 && activeV.length > 0}
                      <Button
                        icon={IconArrowRight}
                        kind={'positive'}
                        label={adminRes.string.MassMigrate}
                        labelParams={{ count: activeV.length, region: selectedRegionName ?? '' }}
                        on:click={(ev) => {
                          ev.stopPropagation()
                          void otpGuardedOp(
                            activeV.map((it) => it.uuid),
                            'migrate-to',
                            selectedRegionId
                          ).then(() => {
                            void loadPage()
                          })
                        }}
                      />
                    {/if}
                  </div>
                </td>
              </tr>
              {#if expanded}
                {#each v.slice(0, limit) as workspace}
                  {@const lastUsageDays = Math.round((now - (workspace.lastVisit ?? 0)) / (1000 * 3600 * 24))}
                  {@const bIdx = backupIdx.get(workspace.uuid)}
                  {@const stats = statsByWorkspace.get(workspace.uuid ?? '')}
                  <tr class="focused-button" id={`${workspace.uuid}`}>
                    <td>
                      <div class="flex-row-center">
                        <span class="label overflow-label">{workspace.name}</span>
                        <Button
                          icon={IconOpen}
                          size={'small'}
                          kind={'ghost'}
                          on:click={() => select(workspace.url)}
                          showTooltip={{ label: adminRes.string.OpenWorkspaceUrl }}
                        />
                        <Button
                          icon={IconCopy}
                          size={'small'}
                          kind={'ghost'}
                          on:click={() => copyTextToClipboard(workspace.uuid)}
                          showTooltip={{ label: adminRes.string.CopyUuid }}
                        />
                        <Button
                          icon={IconDetails}
                          size={'small'}
                          kind={'ghost'}
                          on:click={() => {
                            showPopup(WorkspaceDetails, { workspace })
                          }}
                          showTooltip={{ label: adminRes.string.Details }}
                        />
                      </div>
                    </td>
                    <td>{stats ? (stats.sessions?.length ?? 0) : ''}</td>
                    <td>
                      {#if stats}
                        {(stats.sessions ?? []).reduceRight(
                          (p, it) => p + (it.mins5.tx + it.mins5.find) + (it.current.tx + it.current.find),
                          0
                        )}
                      {/if}
                    </td>
                    <td>{workspace.region ?? ''}</td>
                    <td>{lastUsageDays} days</td>
                    <td title="Members holding a seat (AI bot excluded), refreshed by billing">
                      {workspace.usageInfo?.usage.membersCount ?? '-'}
                    </td>
                    <td>{workspace.mode ?? '-'}</td>
                    <td>
                      {#if workspace.billingPlan != null}
                        {plans?.labels[workspace.billingPlan] ?? workspace.billingPlan}
                        {#if workspace.billingStatus !== 'active'}
                          <span class="ml-1 content-dark-color">({workspace.billingStatus})</span>
                        {/if}
                      {:else}
                        -
                      {/if}
                    </td>
                    <td title="Rolling 30-day usage (not aligned to billing period)">
                      {fmtTokens(aiTokensByWs.get(workspace.uuid) ?? 0)}
                    </td>
                    <td>{formatMinutes(asrMinutesByWs.get(workspace.uuid) ?? 0)}</td>
                    <td>
                      <div class="flex-row-center">
                        {workspace.processingAttempts}
                        {#if !readOnly && workspace.processingAttempts > 0}
                          <Button
                            on:click={() => {
                              showPopup(MessageBox, {
                                label: adminRes.string.ResetAttempts,
                                labelProps: { url: workspace.url },
                                message: adminRes.string.PleaseConfirm,
                                action: async () => {
                                  await otpGuardedOp(workspace.uuid, 'reset-attempts')
                                }
                              })
                            }}
                            icon={IconDownOutline}
                            size={'small'}
                            kind={'ghost'}
                          />
                        {/if}
                      </div>
                    </td>
                    <td>
                      {#if workspace.processingProgress !== 100 && workspace.processingProgress !== 0}
                        {workspace.processingProgress}%
                      {/if}
                    </td>
                    <td>
                      {#if workspace.backupInfo != null}
                        {@const sz = Math.max(
                          workspace.backupInfo.backupSize,
                          workspace.backupInfo.dataSize + workspace.backupInfo.blobsSize
                        )}
                        {@const szGb = Math.round((sz * 100) / 1024) / 100}
                        {#if szGb > 0}
                          {szGb}Gb
                        {:else}
                          {Math.round(sz * 100) / 100}Mb
                        {/if}
                      {/if}
                      {#if bIdx != null}
                        [#{bIdx}]
                      {/if}
                    </td>
                    <td>
                      {#if workspace.backupInfo != null}
                        {@const hours = Math.round((now - workspace.backupInfo.lastBackup) / (1000 * 3600))}
                        {#if hours > 24}
                          {Math.round(hours / 24)} days
                        {:else}
                          {hours} hours
                        {/if}
                      {/if}
                    </td>
                    <td>
                      <div class="flex-row-center">
                        {#if !readOnly && workspace.mode === 'active'}
                          <Button
                            icon={IconStop}
                            size={'small'}
                            label={adminRes.string.Archive}
                            kind={'ghost'}
                            on:click={() => {
                              void otpGuardedOp(workspace.uuid, 'archive').then(() => {
                                void loadPage()
                              })
                            }}
                          />
                        {/if}
                        {#if !readOnly && workspace.mode === 'archived'}
                          <Button
                            icon={IconStart}
                            size={'small'}
                            kind={'ghost'}
                            label={adminRes.string.Unarchive}
                            on:click={() => {
                              showPopup(MessageBox, {
                                label: adminRes.string.UnarchiveWorkspace,
                                labelProps: { url: workspace.url },
                                message: adminRes.string.PleaseConfirm,
                                action: async () => {
                                  await otpGuardedOp(workspace.uuid, 'unarchive')
                                }
                              })
                            }}
                          />
                        {/if}
                        {#if !readOnly && regionInfo.length > 0 && workspace.mode === 'active' && (workspace.region ?? '') !== selectedRegionId}
                          <Button
                            icon={IconArrowRight}
                            size={'small'}
                            kind={'positive'}
                            label={adminRes.string.Migrate}
                            on:click={() => {
                              void otpGuardedOp(workspace.uuid, 'migrate-to', selectedRegionId).then(() => {
                                void loadPage()
                              })
                            }}
                          />
                        {/if}
                        {#if !readOnly && superAdminMode && !isDeletingMode(workspace.mode) && !isArchivingMode(workspace.mode)}
                          <Button
                            icon={IconStop}
                            size={'small'}
                            kind={'dangerous'}
                            label={adminRes.string.Delete}
                            on:click={() => {
                              void otpGuardedOp(workspace.uuid, 'delete').then(() => {
                                void loadPage()
                              })
                            }}
                          />
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              {/if}
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

<style lang="scss">
  .table-scroll {
    max-height: 40rem;
    overflow: auto;
  }
  .workspaces-table {
    width: 100%;
    // Every cell is nowrap, so this keeps the columns readable and hands the rest to the scroller.
    min-width: max-content;
    border-collapse: collapse;
    th.sortable {
      cursor: pointer;
      user-select: none;
    }
    th.sortable:focus-visible {
      outline: 2px solid var(--primary-button-default);
      outline-offset: -2px;
    }
    th.sorted {
      color: var(--theme-caption-color);
    }
    th,
    td {
      text-align: left;
      white-space: nowrap;
      padding: 0.35rem 1rem 0.35rem 0;
      border-bottom: 1px solid var(--theme-divider-color, #8883);
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--theme-comp-header-color);
    }
    .group-row td {
      font-weight: 600;
      background: var(--theme-comp-header-color);
    }
  }
</style>
