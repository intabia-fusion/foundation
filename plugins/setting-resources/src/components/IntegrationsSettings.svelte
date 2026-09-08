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
  import { type ApiKeyInfo, type CreatedApiKey } from '@hcengineering/account-client'
  import core, { AccountRole, type Ref, type Space, getCurrentAccount, hasAccountRole } from '@hcengineering/core'
  import { MessageBox, createQuery } from '@hcengineering/presentation'
  import setting, { type WebhookEndpoint, type WebhookStat } from '@hcengineering/setting'
  import {
    Breadcrumbs,
    Header,
    Scroller,
    getCurrentResolvedLocation,
    navigate,
    resolvedLocationStore,
    showPopup
  } from '@hcengineering/ui'
  import { onMount } from 'svelte'
  import settingsRes from '../plugin'
  import { getAccountClient } from '../utils'
  import ApiKeyPopup from './ApiKeyPopup.svelte'
  import ApiKeysSection from './ApiKeysSection.svelte'
  import CreateApiKeyPopup from './CreateApiKeyPopup.svelte'
  import CreateWebhookEndpoint from './CreateWebhookEndpoint.svelte'
  import WebhookExamplesSection from './WebhookExamplesSection.svelte'
  import WebhookIncomingExample from './WebhookIncomingExample.svelte'
  import WebhookOutgoingExample from './WebhookOutgoingExample.svelte'
  import WebhookEndpointEditor from './WebhookEndpointEditor.svelte'
  import WebhookEndpointsSection from './WebhookEndpointsSection.svelte'

  // Same role check as before this page merged the two categories - a non-Owner must see the Incoming
  // section only, never any Outgoing recipient, URL or control.
  const isOwner = hasAccountRole(getCurrentAccount(), AccountRole.Owner)
  const myAccount = getCurrentAccount().uuid

  // ---- Incoming (API keys) ----

  let loading = true
  let keys: ApiKeyInfo[] = []
  let limit = 0
  let personalLimit = 0

  // Mirrors isApiKeyUsable in server/account/src/apiKeys.ts
  function isUsable (key: ApiKeyInfo): boolean {
    return key.revokedOn === undefined && (key.expiresOn === undefined || key.expiresOn > Date.now())
  }

  // Owner's listApiKeys() returns every key in the workspace - keep only the caller's own personal keys here.
  $: personalKeys = keys.filter((k) => k.personal === true && k.createdBy === myAccount)
  $: integrationKeys = keys.filter((k) => k.personal !== true)
  $: personalUsed = personalKeys.filter(isUsable).length
  $: integrationUsed = integrationKeys.filter(isUsable).length

  function loadKeys (): void {
    loading = true
    getAccountClient()
      .listApiKeys()
      .then((res) => {
        keys = res.keys
        limit = res.limit
        personalLimit = res.personalLimit
        loading = false
      })
      .catch((err: any) => {
        console.error('Failed to load API keys', err)
        loading = false
      })
  }

  // Resolves the names of every space referenced by any key, for each row's expanded detail.
  let spaceNames = new Map<Ref<Space>, string>()
  const spacesQuery = createQuery()
  $: {
    const ids = Array.from(new Set(keys.flatMap((k) => k.spaces)))
    if (ids.length > 0) {
      spacesQuery.query(core.class.Space, { _id: { $in: ids } }, (res) => {
        spaceNames = new Map(res.map((s) => [s._id, s.name]))
      })
    } else {
      spacesQuery.unsubscribe()
      spaceNames = new Map()
    }
  }

  // Received-message counts per key, one workspace query for the whole page (not one per row).
  // Map<keyId, Map<operation, count>>
  function groupStats (stats: WebhookStat[]): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>()
    for (const s of stats) {
      let byType = result.get(s.target)
      if (byType === undefined) {
        byType = new Map()
        result.set(s.target, byType)
      }
      byType.set(s.type, s.count)
    }
    return result
  }

  let inStats: WebhookStat[] = []
  const inStatsQuery = createQuery()
  inStatsQuery.query(setting.class.WebhookStat, { direction: 'in' }, (res) => {
    inStats = res
  })
  $: inStatsByKey = groupStats(inStats)

  function openCreate (personal: boolean): void {
    showPopup(CreateApiKeyPopup, { personal }, 'top', (result?: CreatedApiKey) => {
      if (result != null) {
        showPopup(ApiKeyPopup, { apiKey: result.key })
        loadKeys()
      }
    })
  }

  function revokeKey (key: ApiKeyInfo): void {
    showPopup(MessageBox, {
      labelStr: key.name,
      message: settingsRes.string.RevokeApiKeyConfirm,
      dangerous: true,
      okLabel: settingsRes.string.RevokeApiKey,
      action: async () => {
        await getAccountClient().revokeApiKey(key.keyId)
        loadKeys()
      }
    })
  }

  onMount(loadKeys)

  // ---- Outgoing (webhooks), Owner only ----

  let endpoints: WebhookEndpoint[] = []
  let endpointsLoading = true
  if (isOwner) {
    const endpointsQuery = createQuery()
    endpointsQuery.query(setting.class.WebhookEndpoint, {}, (res) => {
      endpoints = res
      endpointsLoading = false
    })
  }

  // Sub-pages are addressed by the settings path, the shape the space type editor uses:
  // path[5] names the kind, path[6] the object - here an endpoint id or which example to show.
  $: subEditor = $resolvedLocationStore.path[5]
  $: subObject = $resolvedLocationStore.path[6]
  $: selectedEndpoint = isOwner && subEditor === 'endpoints' ? (subObject as Ref<WebhookEndpoint>) : undefined
  $: selectedExample =
    subEditor === 'examples' && (subObject === 'incoming' || subObject === 'outgoing') ? subObject : undefined
  let selectedName: string | undefined

  function openSub (kind?: string, id?: string): void {
    const loc = getCurrentResolvedLocation()
    if (kind !== undefined && id !== undefined) {
      loc.path[5] = kind
      loc.path[6] = id
      loc.path.length = 7
    } else {
      loc.path.length = 5
    }
    navigate(loc)
  }

  function openEndpoint (id: Ref<WebhookEndpoint> | undefined): void {
    openSub(id !== undefined ? 'endpoints' : undefined, id)
  }

  function createEndpoint (): void {
    showPopup(CreateWebhookEndpoint, {}, 'top', (id?: Ref<WebhookEndpoint>) => {
      if (id != null) {
        openEndpoint(id)
      }
    })
  }

  $: exampleLabel =
    selectedExample === 'incoming'
      ? settingsRes.string.WebhookExamplesIncoming
      : settingsRes.string.WebhookExamplesOutgoing
  $: bcItems = [
    { icon: settingsRes.icon.Setting, label: settingsRes.string.ApiAndWebhooks },
    ...(selectedEndpoint !== undefined ? [{ title: selectedName ?? selectedEndpoint }] : []),
    ...(selectedExample !== undefined ? [{ label: exampleLabel }] : [])
  ]
</script>

<div class="hulyComponent">
  <Header adaptive={'disabled'}>
    <Breadcrumbs
      items={bcItems}
      size="large"
      selected={bcItems.length - 1}
      on:select={(e) => {
        if (e.detail === 0) openSub()
      }}
    />
  </Header>
  {#if selectedEndpoint !== undefined}
    {#key selectedEndpoint}
      <WebhookEndpointEditor
        objectId={selectedEndpoint}
        bind:name={selectedName}
        on:close={() => {
          openSub()
        }}
      />
    {/key}
  {:else if selectedExample === 'incoming'}
    <WebhookIncomingExample />
  {:else if selectedExample === 'outgoing'}
    <WebhookOutgoingExample />
  {:else}
    <div class="hulyComponent-content__container">
      <div class="hulyComponent-content__column content">
        <Scroller align={'center'} padding={'var(--spacing-3)'} bottomPadding={'var(--spacing-3)'}>
          <div class="hulyComponent-content gap">
            <div id="personalKeys" class="hulyTableAttr-container">
              <ApiKeysSection
                personal
                keys={personalKeys}
                used={personalUsed}
                limit={personalLimit}
                {loading}
                {spaceNames}
                statsByKey={inStatsByKey}
                onCreate={openCreate}
                onRevoke={revokeKey}
              />
            </div>

            {#if isOwner}
              <div id="integrationKeys" class="hulyTableAttr-container">
                <ApiKeysSection
                  personal={false}
                  keys={integrationKeys}
                  used={integrationUsed}
                  {limit}
                  {loading}
                  {spaceNames}
                  statsByKey={inStatsByKey}
                  onCreate={openCreate}
                  onRevoke={revokeKey}
                />
              </div>

              <div id="outgoing" class="hulyTableAttr-container">
                <WebhookEndpointsSection
                  {endpoints}
                  loading={endpointsLoading}
                  onOpen={openEndpoint}
                  onCreate={createEndpoint}
                />
              </div>
            {/if}

            <div id="examples" class="hulyTableAttr-container">
              <WebhookExamplesSection
                onOpen={(id) => {
                  openSub('examples', id)
                }}
              />
            </div>
          </div>
        </Scroller>
      </div>
    </div>
  {/if}
</div>
