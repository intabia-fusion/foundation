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
  import { type AdminAction } from '@hcengineering/account-client'
  import { reduceCalls } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { Button, ButtonMenu, Label, SearchEdit } from '@hcengineering/ui'

  import adminRes from '../../plugin'
  import { downloadReport, type ReportFormat } from '../../reports'
  import { getAccountClient } from '../../utils'

  export let refreshTick: number = 0

  const accountClient = getAccountClient()

  // Kept in sync with logAdminAction call sites in server/account/src
  const ACTIONS = [
    'release_social_id',
    'delete_person',
    'delete_account',
    'update_workspace_role',
    'add_workspace_member',
    'remove_workspace_member',
    'update_subscription',
    'cancel_subscription',
    'rename_workspace',
    'change_workspace_url',
    'workspace_delete',
    'workspace_archive',
    'workspace_migrate-to'
  ]
  const actionItems = [
    { id: 'all', label: adminRes.string.AllOperations },
    ...ACTIONS.map((a) => ({ id: a, label: getEmbeddedLabel(a) }))
  ]

  let search = ''
  let action = 'all'
  let skip = 0
  const limit = 50
  let actions: AdminAction[] = []
  let total = 0

  const load = reduceCalls(async (): Promise<void> => {
    const res = await accountClient.listAdminActions({
      search,
      action: action === 'all' ? undefined : action,
      skip,
      limit
    })
    actions = res.actions
    total = res.total
  })

  let prevKey = ''
  $: key = `${refreshTick}:${action}:${skip}`
  $: if (key !== prevKey) {
    prevKey = key
    void load()
  }

  let exporting = false
  let reportFormat: ReportFormat = 'csv'
  async function exportActions (): Promise<void> {
    exporting = true
    try {
      await downloadReport('admin-actions', reportFormat, { search, action: action === 'all' ? undefined : action })
    } catch (err) {
      console.error('Admin actions export failed:', err)
    } finally {
      exporting = false
    }
  }

  function fmtTime (ms: number): string {
    return new Date(ms).toLocaleString()
  }

  function fmtData (data: Record<string, any> | undefined): string {
    if (data == null) return ''
    return JSON.stringify(data)
  }
</script>

<div class="fs-title p-3"><Label label={adminRes.string.AuditTitle} /></div>

<div class="fs-title p-3 flex-no-shrink">
  <SearchEdit
    bind:value={search}
    width={'100%'}
    on:change={() => {
      skip = 0
      void load()
    }}
  />
</div>

<div class="flex-row-center flex-wrap p-3">
  <Button
    label={adminRes.string.Previous}
    size={'small'}
    disabled={skip === 0}
    on:click={() => (skip = Math.max(0, skip - limit))}
  />
  <span class="mx-2">
    <Label label={adminRes.string.Page} />
    {Math.floor(skip / limit) + 1} / {Math.max(1, Math.ceil(total / limit))}
  </span>
  <Button
    label={adminRes.string.Next}
    size={'small'}
    disabled={skip + limit >= total}
    on:click={() => (skip += limit)}
  />

  <span class="ml-4 mr-1"><Label label={adminRes.string.Operation} /></span>
  <ButtonMenu
    selected={action}
    title={action === 'all' ? undefined : action}
    items={actionItems}
    on:selected={(it) => {
      skip = 0
      action = it.detail
    }}
  />

  <div class="ml-4 flex-row-center">
    <Button
      label={adminRes.string.Export}
      kind={'primary'}
      size={'small'}
      disabled={exporting}
      on:click={() => {
        void exportActions()
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
  {#if actions.length === 0}
    <div class="content-dark-color"><Label label={adminRes.string.NoOperations} /></div>
  {:else}
    <table class="audit-table">
      <thead>
        <tr>
          <th><Label label={adminRes.string.Date} /></th>
          <th><Label label={adminRes.string.Actor} /></th>
          <th><Label label={adminRes.string.Operation} /></th>
          <th><Label label={adminRes.string.Target} /></th>
          <th><Label label={adminRes.string.Info} /></th>
        </tr>
      </thead>
      <tbody>
        {#each actions as a}
          <tr>
            <td>{fmtTime(a.createdOn)}</td>
            <td>
              <div>{a.actorEmail ?? '-'}</div>
              <div class="content-dark-color">{a.actor}</div>
            </td>
            <td>{a.action}</td>
            <td>
              <div>{a.targetLabel ?? ''}</div>
              <div class="content-dark-color">{a.target ?? ''}</div>
            </td>
            <td class="data-cell">{fmtData(a.data)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style lang="scss">
  .audit-table {
    width: 100%;
    border-collapse: collapse;
    th,
    td {
      text-align: left;
      padding: 0.35rem 1rem 0.35rem 0;
      border-bottom: 1px solid var(--theme-divider-color, #8883);
      vertical-align: top;
    }
    .data-cell {
      max-width: 24rem;
      word-break: break-all;
      font-size: 0.75rem;
    }
  }
</style>
