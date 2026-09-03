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
  import type { TransactorEndpointInfo } from '@hcengineering/account-client'
  import { concatLink } from '@hcengineering/core'
  import login from '@hcengineering/login'
  import { getEmbeddedLabel, getMetadata } from '@hcengineering/platform'
  import presentation from '@hcengineering/presentation'
  import { Button, DropdownLabels, EditBox, IconArrowLeft, IconArrowRight, ticker } from '@hcengineering/ui'

  import { adminFetch, getAccountClient, requestAdminOtpCode } from '../../utils'

  const token: string = getMetadata(presentation.metadata.Token) ?? ''

  let warningTimeout = 15
  let maintenanceMessage = 'A new version is planned to be installed in'

  // Manage calls must target a specific transactor, not whatever endpoint the admin session has
  let transactors: TransactorEndpointInfo[] = []
  let selectedTransactor = ''
  void getAccountClient()
    .getTransactorEndpoints()
    .then((eps) => {
      transactors = eps
      if (selectedTransactor === '' && eps.length > 0) {
        selectedTransactor = eps[0].external
      }
    })
  $: transactorItems = transactors.map((t) => ({
    id: t.external,
    label: `${t.name ?? (t.region === '' ? 'Default' : t.region)} - ${t.external}`
  }))
  $: endpoint = selectedTransactor.replace(/^ws/, 'http').replace(/\/$/, '')

  // Maintenance is a global broadcast: an audited, OTP-gated account RPC, not a raw endpoint.
  async function setMaintenance (timeoutMinutes: number, message: string | undefined): Promise<void> {
    const code = await requestAdminOtpCode()
    if (code === undefined) return
    try {
      await getAccountClient().adminSetMaintenance(timeoutMinutes, message, code)
    } catch (err) {
      console.error('Failed to set maintenance warning:', err)
    }
  }

  let profiling = false
  async function fetchProfiling (time: number): Promise<void> {
    if (endpoint === '') return
    try {
      const res = await adminFetch(endpoint + '/api/v1/profiling', {
        headers: { 'Content-Type': 'application/json' }
      })
      profiling = (await res.json())?.profiling ?? false
    } catch (err) {
      console.error(err, time)
    }
  }
  $: void fetchProfiling($ticker)
  $: if (endpoint !== '') void fetchProfiling(0)

  async function downloadProfile (): Promise<void> {
    const link = document.createElement('a')
    link.style.display = 'none'
    link.setAttribute('target', '_blank')
    const json = await (
      await adminFetch(endpoint + '/api/v1/manage?operation=profile-stop', {
        method: 'PUT'
      })
    ).json()
    link.setAttribute(
      'href',
      'data:application/json;charset=utf-8,%EF%BB%BF' + encodeURIComponent(JSON.stringify(json))
    )
    link.setAttribute('download', `profile-${Date.now()}.cpuprofile`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    await fetchProfiling(0)
  }
</script>

<div class="flex flex-col">
  <!-- Maintenance warning is global (account service) -->
  <div class="flex-row-center p-1">
    <div class="p-3">1.</div>
    <div class="flex p-1 flex-row-center">
      <div class="flex-row-center flex-grow">
        <EditBox bind:value={maintenanceMessage}></EditBox>
      </div>
      <Button
        icon={IconArrowRight}
        label={getEmbeddedLabel('Set maintenance warning')}
        on:click={() => {
          void setMaintenance(warningTimeout, maintenanceMessage)
        }}
      />
    </div>
    <div class="flex-col p-1">
      <div class="flex-row-center p-1">
        <EditBox kind={'underline'} format={'number'} bind:value={warningTimeout} /> min
      </div>
    </div>
    <Button
      icon={IconArrowLeft}
      label={getEmbeddedLabel('Clear warning')}
      on:click={() => {
        void setMaintenance(-1, undefined)
      }}
    />
  </div>

  <!-- Per-transactor operations -->
  <div class="flex-row-center p-1">
    <div class="p-3">2.</div>
    <DropdownLabels items={transactorItems} bind:selected={selectedTransactor} label={getEmbeddedLabel('Transactor')} />
    <div class="ml-2">
      {#if !profiling}
        <Button
          label={getEmbeddedLabel('Profile server')}
          disabled={endpoint === ''}
          on:click={() => {
            void adminFetch(endpoint + '/api/v1/manage?operation=profile-start', {
              method: 'PUT'
            })
            void fetchProfiling(0)
          }}
        />
      {:else}
        <Button label={getEmbeddedLabel('Profile Stop')} on:click={downloadProfile} />
      {/if}
    </div>
  </div>
</div>
