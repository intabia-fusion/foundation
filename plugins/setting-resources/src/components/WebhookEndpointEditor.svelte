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
  import core, { concatLink, SortingOrder, type Ref, type Space } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import presentation, { copyTextToClipboard, createQuery, getClient, MessageBox } from '@hcengineering/presentation'
  import setting, {
    generateWebhookSecret,
    webhookEventSamples,
    type WebhookDelivery,
    type WebhookEndpoint,
    type WebhookSecretEntry,
    type WebhookStat
  } from '@hcengineering/setting'
  import {
    Button,
    ButtonIcon,
    CheckBox,
    Chip,
    Icon,
    IconAdd,
    Label,
    ModernEditbox,
    ModernToggle,
    Scroller,
    eventToHTMLElement,
    showPopup
  } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import settingsRes from '../plugin'
  import { isApiKeyPickableSpace } from '../utils'
  import { webhookEventLabels, webhookEventTypes, type WebhookEventType } from '../webhookEvents'
  import ApiKeySpacesPopup from './ApiKeySpacesPopup.svelte'

  export let objectId: Ref<WebhookEndpoint>
  // The sub-editor contract of the space-type editors: the frame shows this in the breadcrumbs.
  export let name: string | undefined = undefined
  export let readonly: boolean = false

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()

  let endpoint: WebhookEndpoint | undefined
  let url = ''
  const detailQuery = createQuery()
  $: detailQuery.query(setting.class.WebhookEndpoint, { _id: objectId }, (res) => {
    endpoint = res[0]
    name = endpoint?.url
    url = endpoint?.url ?? ''
  })

  let deliveries: WebhookDelivery[] = []
  const deliveryQuery = createQuery()
  $: deliveryQuery.query(
    setting.class.WebhookDelivery,
    { endpoint: objectId },
    (res) => {
      deliveries = res
    },
    { sort: { createdOn: SortingOrder.Descending }, limit: 20 }
  )

  // Delivered counts per event type of this endpoint.
  let sentByType = new Map<string, number>()
  const statsQuery = createQuery()
  $: statsQuery.query(setting.class.WebhookStat, { direction: 'out', target: objectId }, (res: WebhookStat[]) => {
    sentByType = new Map(res.map((s) => [s.type, s.count]))
  })

  // Same set ApiKeySpacesPopup offers, so "Add all" and the picker can never disagree.
  let pickableSpaces: Space[] = []
  let spaceNames = new Map<Ref<Space>, string>()
  const spacesQuery = createQuery()
  spacesQuery.query(core.class.Space, {}, (res) => {
    pickableSpaces = res.filter((s) => isApiKeyPickableSpace(hierarchy, s))
    spaceNames = new Map(pickableSpaces.map((s) => [s._id, s.name]))
  })

  // A stand served over plain http has no TLS to protect anyway, and its pod runs with
  // ALLOW_INSECURE_WEBHOOK_HTTP - only there is an http recipient accepted.
  const allowHttp = location.protocol !== 'https:'
  $: urlValid = (allowHttp ? /^https?:\/\// : /^https:\/\//).test(url.trim())

  let revealedSecretIds = new Set<string>()
  let testing = false
  let testResult: { delivered: boolean, status?: number, error?: string } | undefined
  // Which event's sample is shown in the right-hand panel - independent of the checkbox selection.
  let selectedExampleType: WebhookEventType = webhookEventTypes[0]

  async function update (upd: Partial<WebhookEndpoint>): Promise<void> {
    if (endpoint === undefined || readonly) return
    await client.updateDoc(setting.class.WebhookEndpoint, core.space.Workspace, endpoint._id, upd)
  }

  async function commitUrl (): Promise<void> {
    if (endpoint === undefined || !urlValid || url.trim() === endpoint.url) return
    await update({ url: url.trim() })
  }

  async function toggleEvent (type: WebhookEventType, checked: boolean): Promise<void> {
    if (endpoint === undefined) return
    const events = new Set(endpoint.events)
    if (checked) events.add(type)
    else events.delete(type)
    await update({ events: Array.from(events) })
  }

  async function toggleEnabled (): Promise<void> {
    if (endpoint === undefined) return
    const enabled = !endpoint.enabled
    // Re-enabling clears failureCount - delivery.ts only resets it on a successful delivery, so a manual
    // re-enable after an auto-disable would otherwise start back at the old count.
    await update({ enabled, ...(enabled ? { failureCount: 0 } : {}) })
  }

  function pickSpaces (event: MouseEvent): void {
    showPopup(
      ApiKeySpacesPopup,
      { selectedObjects: endpoint?.spaces ?? [] },
      eventToHTMLElement(event),
      undefined,
      (result: Ref<Space>[] | undefined) => {
        if (result != null) {
          void update({ spaces: result })
        }
      }
    )
  }

  async function addSecret (): Promise<void> {
    if (endpoint === undefined || endpoint.secrets.length >= 2) return
    const newSecret: WebhookSecretEntry = {
      id: crypto.randomUUID(),
      secret: generateWebhookSecret(),
      createdOn: Date.now()
    }
    await update({ secrets: [...endpoint.secrets, newSecret] })
    revealedSecretIds.add(newSecret.id)
    revealedSecretIds = revealedSecretIds
  }

  function revokeSecret (secretId: string): void {
    if (endpoint === undefined || endpoint.secrets.length <= 1) return
    const current = endpoint
    showPopup(MessageBox, {
      label: settingsRes.string.WebhookSecretRevoke,
      message: settingsRes.string.WebhookSecretRevokeConfirm,
      dangerous: true,
      okLabel: settingsRes.string.WebhookSecretRevoke,
      action: async () => {
        await update({ secrets: current.secrets.filter((s) => s.id !== secretId) })
      }
    })
  }

  function toggleReveal (secretId: string): void {
    if (revealedSecretIds.has(secretId)) revealedSecretIds.delete(secretId)
    else revealedSecretIds.add(secretId)
    revealedSecretIds = revealedSecretIds
  }

  function maskSecret (secret: string): string {
    return `${secret.slice(0, 10)}••••••••${secret.slice(-4)}`
  }

  async function copySecret (secret: string): Promise<void> {
    if (!window.isSecureContext) return
    await copyTextToClipboard(secret)
  }

  function formatDate (timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  function remove (): void {
    if (endpoint === undefined) return
    const current = endpoint
    showPopup(MessageBox, {
      label: settingsRes.string.WebhookDelete,
      message: settingsRes.string.WebhookDeleteConfirm,
      dangerous: true,
      okLabel: settingsRes.string.WebhookDelete,
      action: async () => {
        await client.removeDoc(setting.class.WebhookEndpoint, core.space.Workspace, current._id)
        dispatch('close')
      }
    })
  }

  async function sendTest (): Promise<void> {
    if (endpoint === undefined) return
    testing = true
    testResult = undefined
    try {
      const base = getMetadata(setting.metadata.WebhookServiceUrl) ?? ''
      const token = getMetadata(presentation.metadata.Token) ?? ''
      const workspace = getMetadata(presentation.metadata.WorkspaceUuid) ?? ''
      const res = await fetch(concatLink(base, `/${workspace}/test/${endpoint._id}`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      testResult = await res.json()
    } catch (err: any) {
      testResult = { delivered: false, error: `${err}` }
    } finally {
      testing = false
    }
  }
</script>

{#if endpoint !== undefined}
  <div class="hulyComponent-content__container columns">
    <div class="hulyComponent-content__column content">
      <Scroller align="center" padding="var(--spacing-3)" bottomPadding="var(--spacing-3)">
        <div class="hulyComponent-content gap">
          <div class="hulyComponent-content__column-group mt-4">
            <ModernEditbox
              bind:value={url}
              label={settingsRes.string.WebhookUrl}
              size="medium"
              disabled={readonly}
              on:change={commitUrl}
              on:blur={commitUrl}
            />
            {#if url.length > 0 && !urlValid}
              <div class="hint warn"><Label label={settingsRes.string.WebhookUrlHttpsOnly} /></div>
            {/if}
            <div class="flex-row-center flex-between mt-4">
              <Label
                label={endpoint.enabled ? settingsRes.string.WebhookEnabled : settingsRes.string.WebhookDisabled}
              />
              <ModernToggle size="small" checked={endpoint.enabled} disabled={readonly} on:change={toggleEnabled} />
            </div>
          </div>

          <div class="hulyTableAttr-container">
            <div class="hulyTableAttr-header font-medium-12">
              <Icon icon={settingsRes.icon.Setting} size="small" />
              <span><Label label={settingsRes.string.WebhookEventsLabel} /></span>
            </div>
            <div class="hulyTableAttr-content">
              <div class="flex-row-stretch flex-gap-4 eventsSection">
                <div class="flex-col flex-gap-2 eventsList">
                  <div class="hint"><Label label={settingsRes.string.WebhookEventsHint} /></div>
                  {#each webhookEventTypes as type}
                    <div class="eventRow" class:selected={selectedExampleType === type}>
                      <CheckBox
                        checked={endpoint.events.includes(type)}
                        {readonly}
                        on:value={(e) => {
                          void toggleEvent(type, e.detail)
                        }}
                      />
                      <button
                        type="button"
                        class="eventLabelBtn"
                        on:click={() => {
                          selectedExampleType = type
                        }}
                      >
                        <Label label={webhookEventLabels[type]} />
                      </button>
                      {#if (sentByType.get(type) ?? 0) > 0}
                        <span class="hint">
                          <Label
                            label={settingsRes.string.WebhookEventDeliveredCount}
                            params={{ count: sentByType.get(type) }}
                          />
                        </span>
                      {/if}
                    </div>
                  {/each}
                </div>
                <div class="examplePanel">
                  <div class="hint"><Label label={settingsRes.string.WebhookExamplePayload} /></div>
                  <pre class="samplePayload">{JSON.stringify(webhookEventSamples[selectedExampleType], null, 2)}</pre>
                </div>
              </div>
            </div>
          </div>

          <div class="hulyTableAttr-container">
            <div class="hulyTableAttr-header font-medium-12">
              <Icon icon={settingsRes.icon.Setting} size="small" />
              <span><Label label={settingsRes.string.WebhookSpaces} /></span>
              <ButtonIcon
                kind="primary"
                icon={IconAdd}
                size="small"
                dataId="btnPickWebhookSpaces"
                disabled={readonly}
                on:click={pickSpaces}
              />
            </div>
            <div class="hulyTableAttr-content section">
              <div class="hint"><Label label={settingsRes.string.WebhookSpacesHint} /></div>
              {#if endpoint.spaces !== undefined && endpoint.spaces.length > 0}
                {@const selected = endpoint.spaces}
                <div class="chips">
                  {#each selected as spaceId (spaceId)}
                    <Chip
                      label={spaceNames.get(spaceId) ?? spaceId}
                      isRemovable={!readonly}
                      on:remove={() => {
                        void update({ spaces: selected.filter((id) => id !== spaceId) })
                      }}
                    />
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <div class="hulyTableAttr-container">
            <div class="hulyTableAttr-header font-medium-12">
              <Icon icon={settingsRes.icon.Setting} size="small" />
              <span><Label label={settingsRes.string.WebhookSecrets} /></span>
              <ButtonIcon
                kind="primary"
                icon={IconAdd}
                size="small"
                dataId="btnAddWebhookSecret"
                disabled={readonly || endpoint.secrets.length >= 2}
                on:click={addSecret}
              />
            </div>
            <div class="hulyTableAttr-content section">
              <div class="hint"><Label label={settingsRes.string.WebhookSecretShownHint} /></div>
              <div class="hint"><Label label={settingsRes.string.WebhookSecretAddHint} /></div>
              {#if endpoint.secrets.length >= 2}
                <div class="hint"><Label label={settingsRes.string.WebhookSecretMaxTwo} /></div>
              {:else}
                <div class="hint"><Label label={settingsRes.string.WebhookSecretMinOne} /></div>
              {/if}
              {#each endpoint.secrets as secret (secret.id)}
                <div class="secretRow">
                  <div class="flex-col flex-gap-1">
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <div
                      class="secretValue"
                      on:click={() => {
                        void copySecret(secret.secret)
                      }}
                    >
                      {revealedSecretIds.has(secret.id) ? secret.secret : maskSecret(secret.secret)}
                    </div>
                    <div class="hint">
                      <Label label={settingsRes.string.WebhookSecretCreatedOn} />: {formatDate(secret.createdOn)}
                    </div>
                  </div>
                  <div class="flex-row-center flex-gap-2">
                    <Button
                      label={revealedSecretIds.has(secret.id)
                        ? settingsRes.string.WebhookSecretHide
                        : settingsRes.string.WebhookSecretReveal}
                      kind="ghost"
                      size="small"
                      on:click={() => {
                        toggleReveal(secret.id)
                      }}
                    />
                    <Button
                      label={settingsRes.string.WebhookSecretRevoke}
                      kind="dangerous"
                      size="small"
                      disabled={readonly || endpoint.secrets.length <= 1}
                      on:click={() => {
                        revokeSecret(secret.id)
                      }}
                    />
                  </div>
                </div>
              {/each}
            </div>
          </div>

          <div class="hulyTableAttr-container">
            <div class="hulyTableAttr-header font-medium-12">
              <Icon icon={settingsRes.icon.Setting} size="small" />
              <span><Label label={settingsRes.string.WebhookDeliveries} /></span>
              <Button
                label={settingsRes.string.WebhookSendTest}
                kind="regular"
                size="small"
                loading={testing}
                disabled={readonly}
                on:click={sendTest}
              />
            </div>
            <div class="hulyTableAttr-content section">
              {#if testResult !== undefined}
                <div class="hint" class:warn={!testResult.delivered}>
                  {#if testResult.delivered}
                    <Label label={settingsRes.string.WebhookTestSuccess} params={{ status: testResult.status }} />
                  {:else if testResult.status !== undefined}
                    <Label
                      label={settingsRes.string.WebhookTestFailure}
                      params={{ error: `HTTP ${testResult.status}` }}
                    />
                  {:else}
                    <Label label={settingsRes.string.WebhookTestFailure} params={{ error: testResult.error ?? '' }} />
                  {/if}
                </div>
              {/if}
              {#if endpoint.lastError !== undefined}
                <div class="hint warn"><Label label={settingsRes.string.WebhookLastError} />: {endpoint.lastError}</div>
              {/if}
              {#if deliveries.length === 0}
                <div class="hint"><Label label={settingsRes.string.WebhookDeliveriesEmpty} /></div>
              {:else}
                {#each deliveries as delivery (delivery._id)}
                  <div class="deliveryRow">
                    <span>{formatDate(delivery.createdOn ?? 0)}</span>
                    {#if delivery.status !== undefined}
                      <span>
                        <Label label={settingsRes.string.WebhookDeliverySuccess} params={{ status: delivery.status }} />
                      </span>
                    {:else}
                      <span class="warn">
                        <Label
                          label={settingsRes.string.WebhookDeliveryFailed}
                          params={{ error: delivery.error ?? '' }}
                        />
                      </span>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>

          {#if !readonly}
            <div class="flex-row-reverse">
              <Button label={settingsRes.string.WebhookDelete} kind="dangerous" size="small" on:click={remove} />
            </div>
          {/if}
        </div>
      </Scroller>
    </div>
  </div>
{/if}

<style lang="scss">
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: var(--spacing-2);
  }
  .hint {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }
  .warn {
    color: var(--theme-error-color);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .eventsSection {
    align-items: flex-start;
    padding: var(--spacing-2);
  }
  .eventsList {
    flex: 1;
    min-width: 12rem;
  }
  .eventRow {
    display: flex;
    align-items: center;
    gap: 0.5rem;

    &.selected .eventLabelBtn {
      color: var(--theme-caption-color);
    }
  }
  .eventLabelBtn {
    background: none;
    border: none;
    padding: 0;
    color: var(--theme-content-color);
    cursor: pointer;
  }
  .examplePanel {
    flex: 1;
    min-width: 16rem;
  }
  .samplePayload {
    margin: 0.25rem 0 0;
    padding: 0.5rem;
    max-height: 16rem;
    overflow: auto;
    border-radius: 0.375rem;
    background: var(--theme-bg-accent-color);
    font-family: monospace;
    font-size: 0.75rem;
  }
  .secretRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .secretValue {
    font-family: monospace;
    word-break: break-all;
    cursor: pointer;
  }
  .deliveryRow {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
</style>
