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
  import { type AccountAggregatedInfo, type AccountsFilter, type AccountsSortKey } from '@hcengineering/account-client'
  import { type AccountUuid, reduceCalls } from '@hcengineering/core'
  import { getEmbeddedLabel, translate } from '@hcengineering/platform'
  import { copyTextToClipboard, isAdminUser, isBillingAdminUser } from '@hcengineering/presentation'
  import {
    Button,
    ButtonMenu,
    CheckBox,
    IconCopy,
    IconDetails,
    IconStop,
    Label,
    SearchEdit,
    showPopup,
    themeStore
  } from '@hcengineering/ui'

  import adminRes from '../../plugin'
  import AccountDetails from '../AccountDetails.svelte'
  import { downloadReport, type ReportFormat } from '../../reports'
  import { getAccountClient, requestAdminOtpCode } from '../../utils'

  export let refreshTick: number = 0

  const accountClient = getAccountClient()

  // Read-only billing admin: hide all mutating controls (server also rejects).
  const readOnly = isBillingAdminUser() && !isAdminUser()

  let accountSuperAdminMode = false

  let accountSearch = ''
  let accountSkip = 0
  const accountLimit = 25
  let accounts: AccountAggregatedInfo[] = []

  let sortKey: AccountsSortKey = 'lastVisit'
  let sortAsc = false

  // Names and emails read A-Z, every other column starts from the biggest/most recent.
  function sortBy (key: AccountsSortKey): void {
    if (sortKey === key) {
      sortAsc = !sortAsc
      return
    }
    sortKey = key
    sortAsc = key === 'name' || key === 'email'
  }

  // Reactive: a plain function called with a constant key would never be re-evaluated.
  $: sortMark = (key: AccountsSortKey): string => (sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : '')
  $: ariaSort = (key: AccountsSortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === key ? (sortAsc ? 'ascending' : 'descending') : 'none'

  function sortOnKey (e: KeyboardEvent, key: AccountsSortKey): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      sortBy(key)
    }
  }

  let noWorkspaces = false
  let pendingOnly = false
  let inactiveDays: number | undefined
  // ButtonMenu drops falsy ids (`if (result)`), so ids must be non-empty strings
  const inactiveItems = [
    { id: 'any', label: adminRes.string.AnyActivity },
    ...[1, 5, 7, 14].map((d) => ({ id: String(d), label: getEmbeddedLabel(`${d}d+`) }))
  ]
  let filter: AccountsFilter = {}
  $: filter = {
    noWorkspaces: noWorkspaces ? true : undefined,
    pendingOnly: pendingOnly ? true : undefined,
    inactiveDays
  }

  let inactiveTitle = ''
  $: if (inactiveDays === undefined) {
    void translate(adminRes.string.AnyActivity, {}, $themeStore.language).then((t) => {
      inactiveTitle = t
    })
  } else {
    inactiveTitle = `${inactiveDays}d+`
  }

  const loadAccounts = reduceCalls(async (search?: string, skip?: number, limit?: number): Promise<void> => {
    accounts = await accountClient.listAccounts(search, skip, limit, sortKey, filter, sortAsc ? 'asc' : 'desc')
  })

  let prevKey = ''
  $: key = `${refreshTick}:${sortKey}:${String(sortAsc)}:${String(noWorkspaces)}:${String(pendingOnly)}:${inactiveDays ?? ''}`
  $: if (key !== prevKey) {
    if (prevKey !== '') accountSkip = 0
    prevKey = key
    void loadAccounts(accountSearch, accountSkip, accountLimit)
  }

  let exporting = false
  let reportFormat: ReportFormat = 'csv'
  async function exportAccounts (): Promise<void> {
    exporting = true
    try {
      await downloadReport('accounts', reportFormat, { search: accountSearch, filter })
    } catch (err) {
      console.error('Accounts export failed:', err)
    } finally {
      exporting = false
    }
  }

  // Last-visit buckets (page-local, list arrives sorted by last_visit DESC)
  const dayRanges: Array<[string, number]> = [
    ['Today', 1],
    ['Week', 7],
    ['Month', 30],
    ['Quarter', 90],
    ['Year', 365],
    ['Older', Infinity]
  ]
  function bucketOf (lastVisit: number | undefined): string {
    if (lastVisit == null || lastVisit === 0) return 'Never'
    const days = (Date.now() - lastVisit) / (24 * 3600 * 1000)
    return dayRanges.find(([, max]) => days <= max)?.[0] ?? 'Older'
  }
  $: groups =
    sortKey === 'lastVisit'
      ? accounts.reduce<Array<{ label: string | null, items: AccountAggregatedInfo[] }>>((res, a) => {
        const label = bucketOf(a.lastVisit)
        const last = res[res.length - 1]
        if (last?.label === label) {
          last.items.push(a)
        } else {
          res.push({ label, items: [a] })
        }
        return res
      }, [])
      : [{ label: null, items: accounts }]

  function lastVisitDays (lastVisit: number | undefined): string {
    if (lastVisit == null || lastVisit === 0) return '-'
    const days = Math.floor((Date.now() - lastVisit) / (24 * 3600 * 1000))
    return `${days}d`
  }

  function fmtDay (ms: number | undefined): string {
    if (ms == null || ms === 0) return '-'
    return new Date(ms).toISOString().slice(0, 10)
  }

  // Account deletion is an irreversible identity purge -> OTP-gated on the server
  function deleteAccount (uuid: AccountUuid): void {
    void requestAdminOtpCode().then((code) => {
      if (code === undefined) return
      void accountClient
        .deleteAccount(uuid, code)
        .then(() => loadAccounts(accountSearch, accountSkip, accountLimit))
        .catch((err) => {
          console.error('Failed to delete account:', err)
        })
    })
  }

  // Unfinished signup has no account row - purge person + social ids instead
  function deletePerson (uuid: AccountUuid): void {
    void requestAdminOtpCode().then((code) => {
      if (code === undefined) return
      void accountClient
        .adminDeletePerson(uuid, code)
        .then(() => loadAccounts(accountSearch, accountSkip, accountLimit))
        .catch((err) => {
          console.error('Failed to delete person:', err)
        })
    })
  }

  async function accountSearchChanged (ev: CustomEvent<string>): Promise<void> {
    accountSkip = 0
    await loadAccounts(ev.detail, accountSkip, accountLimit)
  }

  function primaryEmail (account: AccountAggregatedInfo): string {
    return account.primaryEmail ?? account.socialIds[0]?.value ?? '-'
  }
</script>

<div class="flex-between">
  <div class="fs-title p-3"><Label label={adminRes.string.AccountsAdminTitle} /></div>
  {#if !readOnly}
    <div class="flex-row-center">
      <span class="mr-4"><Label label={adminRes.string.EnableDeletion} /></span>
      <CheckBox bind:checked={accountSuperAdminMode} />
    </div>
  {/if}
</div>
<div class="fs-title p-3 flex-no-shrink">
  <SearchEdit bind:value={accountSearch} width={'100%'} on:change={accountSearchChanged} />
</div>

<div class="flex-row-center p-3">
  <Button
    label={adminRes.string.Previous}
    size={'small'}
    disabled={accountSkip === 0}
    on:click={async () => {
      accountSkip = Math.max(0, accountSkip - accountLimit)
      await loadAccounts(accountSearch, accountSkip, accountLimit)
    }}
  />
  <span class="mx-2"><Label label={adminRes.string.Page} /> {Math.floor(accountSkip / accountLimit) + 1}</span>
  <Button
    label={adminRes.string.Next}
    size={'small'}
    disabled={accounts.length < accountLimit}
    on:click={async () => {
      accountSkip += accountLimit
      await loadAccounts(accountSearch, accountSkip, accountLimit)
    }}
  />
</div>

<div class="flex-row-center flex-wrap p-3">
  <div class="flex-row-center mr-4">
    <CheckBox bind:checked={noWorkspaces} />
    <span class="ml-1"><Label label={adminRes.string.NoWorkspaces} /></span>
  </div>

  <div class="flex-row-center mr-4">
    <CheckBox bind:checked={pendingOnly} />
    <span class="ml-1"><Label label={adminRes.string.PendingSignups} /></span>
  </div>

  <span class="mr-1"><Label label={adminRes.string.InactiveOver} /></span>
  <ButtonMenu
    selected={inactiveDays === undefined ? 'any' : String(inactiveDays)}
    title={inactiveTitle}
    items={inactiveItems}
    on:selected={(it) => {
      inactiveDays = it.detail === 'any' ? undefined : Number(it.detail)
    }}
  />

  <div class="ml-4 flex-row-center">
    <Button
      label={adminRes.string.Export}
      kind={'primary'}
      size={'small'}
      disabled={exporting}
      on:click={() => {
        void exportAccounts()
      }}
    />
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

<div class="p-3 select-text-i">
  <table class="accounts-table">
    <thead>
      <tr>
        <th
          class="sortable"
          class:sorted={sortKey === 'name'}
          aria-sort={ariaSort('name')}
          tabindex="0"
          on:click={() => {
            sortBy('name')
          }}
          on:keydown={(e) => {
            sortOnKey(e, 'name')
          }}
        >
          <Label label={adminRes.string.Accounts} />{sortMark('name')}
        </th>
        <th
          class="sortable"
          class:sorted={sortKey === 'email'}
          aria-sort={ariaSort('email')}
          tabindex="0"
          on:click={() => {
            sortBy('email')
          }}
          on:keydown={(e) => {
            sortOnKey(e, 'email')
          }}
        >
          <Label label={adminRes.string.Email} />{sortMark('email')}
        </th>
        <th><Label label={adminRes.string.SocialIds} /></th>
        <th
          class="sortable"
          class:sorted={sortKey === 'workspaces'}
          aria-sort={ariaSort('workspaces')}
          tabindex="0"
          on:click={() => {
            sortBy('workspaces')
          }}
          on:keydown={(e) => {
            sortOnKey(e, 'workspaces')
          }}
        >
          <Label label={adminRes.string.Workspaces} />{sortMark('workspaces')}
        </th>
        <th
          class="sortable"
          class:sorted={sortKey === 'registeredOn'}
          aria-sort={ariaSort('registeredOn')}
          tabindex="0"
          on:click={() => {
            sortBy('registeredOn')
          }}
          on:keydown={(e) => {
            sortOnKey(e, 'registeredOn')
          }}
        >
          <Label label={adminRes.string.CreatedOn} />{sortMark('registeredOn')}
        </th>
        <th
          class="sortable"
          class:sorted={sortKey === 'lastVisit'}
          aria-sort={ariaSort('lastVisit')}
          tabindex="0"
          on:click={() => {
            sortBy('lastVisit')
          }}
          on:keydown={(e) => {
            sortOnKey(e, 'lastVisit')
          }}
        >
          <Label label={adminRes.string.LastVisit} />{sortMark('lastVisit')}
        </th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each groups as group}
        {#if group.label != null}
          <tr class="group-row">
            <td colspan="7">{group.label} ({group.items.length})</td>
          </tr>
        {/if}
        {#each group.items as account}
          <tr class="focused-button">
            <td>
              <div class="fs-title">{account.firstName} {account.lastName}</div>
              <div class="content-dark-color flex-row-center">
                {account.uuid}
                <Button
                  icon={IconCopy}
                  size={'small'}
                  kind={'ghost'}
                  on:click={() => copyTextToClipboard(account.uuid)}
                  showTooltip={{ label: adminRes.string.CopyUuid }}
                />
              </div>
            </td>
            <td>{primaryEmail(account)}</td>
            <td>{account.socialIds.length}</td>
            <td>{account.workspaces.length}</td>
            <td>{fmtDay(account.registeredOn)}</td>
            <td>{lastVisitDays(account.lastVisit)}</td>
            <td>
              <div class="flex-row-center">
                <Button
                  icon={IconDetails}
                  size={'small'}
                  kind={'ghost'}
                  label={adminRes.string.Details}
                  on:click={() => {
                    showPopup(AccountDetails, { account })
                  }}
                />
                {#if !readOnly && accountSuperAdminMode}
                  <Button
                    icon={IconStop}
                    size={'small'}
                    kind={'dangerous'}
                    label={adminRes.string.Delete}
                    on:click={() => {
                      if (account.hasAccount === false) {
                        deletePerson(account.uuid)
                      } else {
                        deleteAccount(account.uuid)
                      }
                    }}
                  />
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      {/each}
    </tbody>
  </table>
</div>

<style lang="scss">
  .accounts-table {
    width: 100%;
    border-collapse: collapse;
    th,
    td {
      text-align: left;
      padding: 0.35rem 1rem 0.35rem 0;
      border-bottom: 1px solid var(--theme-divider-color, #8883);
    }
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
    .group-row td {
      font-weight: 600;
      background: var(--theme-comp-header-color);
    }
  }
</style>
