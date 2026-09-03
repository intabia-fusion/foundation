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
  import type { AccountAggregatedInfo, AccountActivityStats } from '@hcengineering/account-client'
  import { type SocialIdType } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { copyTextToClipboard, isAdminUser, isBillingAdminUser } from '@hcengineering/presentation'
  import { Button, Dialog, IconCopy, IconStop, Label, Loading } from '@hcengineering/ui'

  import adminRes from '../plugin'
  import { getAccountClient, requestAdminOtpCode } from '../utils'

  export let account: AccountAggregatedInfo

  const accountClient = getAccountClient()

  const readOnly = isBillingAdminUser() && !isAdminUser()

  let releasing: string | undefined
  let releaseError: string | undefined

  // Releasing a social id can cut the person's login -> OTP-gated on the server
  async function releaseSocialId (type: SocialIdType, value: string): Promise<void> {
    const code = await requestAdminOtpCode()
    if (code === undefined) return
    releasing = value
    releaseError = undefined
    try {
      await accountClient.adminReleaseSocialId(account.uuid, type, value, code)
      account.socialIds = account.socialIds.filter((s) => s.value !== value)
    } catch (err: any) {
      releaseError = String(err?.message ?? err)
    } finally {
      releasing = undefined
    }
  }

  const ACTIVITY_WEEKS = 12

  let stats: AccountActivityStats | null = null
  let loading = true

  async function load (): Promise<void> {
    loading = true
    try {
      const from = Date.now() - ACTIVITY_WEEKS * 7 * 24 * 3600 * 1000
      stats = await accountClient.getAccountActivityStats(account.uuid, from).catch(() => null)
    } finally {
      loading = false
    }
  }

  void load()

  function fmtDate (ts: number | undefined): string {
    return ts != null && ts > 0 ? new Date(ts).toLocaleString() : '-'
  }

  $: weekly = stats?.weekly ?? []
  $: maxWeekly = Math.max(1, ...weekly.map((p) => p.count))
</script>

<Dialog
  label={getEmbeddedLabel(`${account.firstName ?? ''} ${account.lastName ?? ''}`.trim() || account.uuid)}
  on:close
>
  {#if loading}
    <Loading />
  {:else}
    <div class="flex-row-top flex-wrap">
      <div class="mr-8 mb-2">
        <div class="fs-title mb-1"><Label label={adminRes.string.Info} /></div>
        <div class="flex-row-center">
          <Label label={adminRes.string.Uuid} />: {account.uuid}
          <Button
            icon={IconCopy}
            size={'small'}
            kind={'ghost'}
            on:click={() => copyTextToClipboard(account.uuid)}
            showTooltip={{ label: adminRes.string.CopyUuid }}
          />
        </div>
        {#if account.timezone != null}
          <div><Label label={adminRes.string.Timezone} />: {account.timezone}</div>
        {/if}
      </div>

      <div class="mr-8 mb-2">
        <div class="fs-title mb-1"><Label label={adminRes.string.SocialIds} /> ({account.socialIds.length})</div>
        {#each account.socialIds as socialId}
          <div class="flex-row-center">
            <span>{socialId.type}: {socialId.value}</span>
            {#if !readOnly}
              <Button
                icon={IconStop}
                size={'small'}
                kind={'ghost'}
                disabled={releasing !== undefined}
                showTooltip={{ label: adminRes.string.ReleaseSocialId }}
                on:click={() => {
                  void releaseSocialId(socialId.type, socialId.value)
                }}
              />
            {/if}
          </div>
        {/each}
        {#if releaseError !== undefined}
          <div class="error-color">{releaseError}</div>
        {/if}
      </div>
    </div>

    <div class="fs-title mt-3 mb-1"><Label label={adminRes.string.Workspaces} /> ({account.workspaces.length})</div>
    {#if account.workspaces.length > 0}
      <div class="scroll-list">
        <table class="info-table">
          <thead>
            <tr>
              <th><Label label={adminRes.string.Name} /></th>
              <th><Label label={adminRes.string.Url} /></th>
              <th><Label label={adminRes.string.Uuid} /></th>
            </tr>
          </thead>
          <tbody>
            {#each account.workspaces as ws}
              <tr>
                <td>{ws.name}</td>
                <td>{ws.url}</td>
                <td>
                  <div class="flex-row-center">
                    {ws.uuid}
                    <Button
                      icon={IconCopy}
                      size={'small'}
                      kind={'ghost'}
                      on:click={() => copyTextToClipboard(ws.uuid)}
                      showTooltip={{ label: adminRes.string.CopyUuid }}
                    />
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="fs-title mt-3 mb-1"><Label label={adminRes.string.WeeklyActivity} /></div>
    {#if weekly.length === 0}
      <div class="content-dark-color"><Label label={adminRes.string.NoActivity} /></div>
    {:else}
      <div class="activity">
        {#each weekly as p}
          <div class="bar-slot" title={`${p.week}: ${p.count} tx`}>
            <div class="bar" style:height={`${Math.max(2, (p.count / maxWeekly) * 48)}px`}></div>
            <div class="bar-label">{p.week.slice(5)}</div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="fs-title mt-3 mb-1"><Label label={adminRes.string.ActivityByWorkspaces} /></div>
    {#if (stats?.workspaces ?? []).length === 0}
      <div class="content-dark-color"><Label label={adminRes.string.NoActivity} /></div>
    {:else}
      <div class="scroll-list">
        <table class="info-table">
          <thead>
            <tr>
              <th><Label label={adminRes.string.Workspace} /></th>
              <th><Label label={adminRes.string.Tx} /></th>
              <th><Label label={adminRes.string.LastActivity} /></th>
            </tr>
          </thead>
          <tbody>
            {#each stats?.workspaces ?? [] as w}
              <tr>
                <td>{w.name ?? w.url ?? w.workspace}</td>
                <td>{w.count}</td>
                <td>{fmtDate(w.lastTx)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</Dialog>

<style lang="scss">
  .activity {
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }
  .bar-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .bar {
    width: 14px;
    background: var(--primary-button-default, #3b82f6);
    border-radius: 2px 2px 0 0;
  }
  .bar-label {
    font-size: 0.65rem;
    color: var(--theme-dark-color, #888);
    margin-top: 2px;
  }
  .info-table {
    border-collapse: collapse;
    th,
    td {
      text-align: left;
      padding: 0.15rem 1rem 0.15rem 0;
      border-bottom: 1px solid var(--theme-divider-color, #8883);
    }
  }
  .scroll-list {
    max-height: 14rem;
    overflow-y: auto;
  }
</style>
