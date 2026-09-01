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
  import core from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import setting, { generateWebhookSecret, type WebhookSecretEntry } from '@hcengineering/setting'
  import { CheckBox, Label, Modal, ModernEditbox } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import settingsRes from '../plugin'
  import { webhookEventLabels, webhookEventTypes, type WebhookEventType } from '../webhookEvents'

  const client = getClient()
  const dispatch = createEventDispatcher()

  let url = ''
  let events = new Set<WebhookEventType>()
  let saving = false
  let error: string | undefined

  // A stand served over plain http has no TLS to protect anyway, and its pod runs with
  // ALLOW_INSECURE_WEBHOOK_HTTP - only there is an http recipient accepted.
  const allowHttp = location.protocol !== 'https:'
  $: urlValid = (allowHttp ? /^https?:\/\// : /^https:\/\//).test(url.trim())
  $: canSave = !saving && urlValid && events.size > 0

  function toggleEvent (type: WebhookEventType, checked: boolean): void {
    if (checked) events.add(type)
    else events.delete(type)
    events = events
  }

  async function save (): Promise<void> {
    if (!canSave) return
    saving = true
    error = undefined
    try {
      const secret: WebhookSecretEntry = {
        id: crypto.randomUUID(),
        secret: generateWebhookSecret(),
        createdOn: Date.now()
      }
      const _id = await client.createDoc(setting.class.WebhookEndpoint, core.space.Workspace, {
        url: url.trim(),
        events: Array.from(events),
        spaces: [],
        secrets: [secret],
        enabled: true,
        failureCount: 0
      })
      dispatch('close', _id)
    } catch (err: any) {
      error = `${err}`
      saving = false
    }
  }
</script>

<Modal
  label={settingsRes.string.AddWebhook}
  type="type-popup"
  width="medium"
  okLabel={settingsRes.string.WebhookCreate}
  okAction={save}
  okLoading={saving}
  {canSave}
  showCancelButton={false}
  onCancel={() => {
    dispatch('close')
  }}
>
  <div class="flex-col-stretch flex-gap-4">
    <ModernEditbox bind:value={url} label={settingsRes.string.WebhookUrl} size="medium" autoFocus />
    {#if url.length > 0 && !urlValid}
      <div class="hint warn"><Label label={settingsRes.string.WebhookUrlHttpsOnly} /></div>
    {/if}

    <div class="flex-col flex-gap-2">
      <Label label={settingsRes.string.WebhookEventsLabel} />
      <div class="hint"><Label label={settingsRes.string.WebhookEventsHint} /></div>
      {#each webhookEventTypes as type}
        <label class="flex-row-center flex-gap-2" for={`event-${type}`}>
          <CheckBox
            id={`event-${type}`}
            checked={events.has(type)}
            on:value={(e) => {
              toggleEvent(type, e.detail)
            }}
          />
          <Label label={webhookEventLabels[type]} />
        </label>
      {/each}
    </div>

    {#if error}
      <div class="hint warn">{error}</div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .hint {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }
  .warn {
    color: var(--theme-error-color);
  }
</style>
