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
  import setting, { generateWebhookSecret, type WebhookSecretEntry } from '@hcengineering/setting'
  import presentation, { getClient } from '@hcengineering/presentation'
  import ui, {
    Button,
    ButtonIcon,
    Chip,
    IconAdd,
    Label,
    Modal,
    ModernEditbox,
    eventToHTMLElement,
    showPopup
  } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import settingsRes from '../plugin'
  import { webhookEventNames, webhookEventTypes, type WebhookEventType } from '../webhookEvents'
  import WebhookEventsPopup from './WebhookEventsPopup.svelte'

  const client = getClient()
  const dispatch = createEventDispatcher()

  let url = ''
  let name = ''
  let events: WebhookEventType[] = []
  let saving = false
  let error: string | undefined

  // A stand served over plain http has no TLS to protect anyway, and its pod runs with
  // ALLOW_INSECURE_WEBHOOK_HTTP - only there is an http recipient accepted.
  const allowHttp = location.protocol !== 'https:'
  $: urlValid = (allowHttp ? /^https?:\/\// : /^https:\/\//).test(url.trim())
  $: canSave = !saving && urlValid && events.length > 0

  function pickEvents (event: MouseEvent): void {
    showPopup(
      WebhookEventsPopup,
      { selected: events },
      eventToHTMLElement(event),
      undefined,
      (result: WebhookEventType[] | undefined) => {
        if (result != null) {
          events = result
        }
      }
    )
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
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        events,
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
    <ModernEditbox bind:value={name} label={core.string.Name} size="medium" autoFocus />
    <ModernEditbox bind:value={url} label={settingsRes.string.WebhookUrl} size="medium" />
    {#if url.length > 0 && !urlValid}
      <div class="hint warn"><Label label={settingsRes.string.WebhookUrlHttpsOnly} /></div>
    {/if}

    <div class="flex-col flex-gap-2">
      <div class="flex-row-center flex-between">
        <Label label={settingsRes.string.WebhookEventsLabel} />
        <div class="flex-row-center flex-gap-1">
          <ButtonIcon
            kind="tertiary"
            size="small"
            icon={IconAdd}
            tooltip={{ label: presentation.string.Add }}
            on:click={pickEvents}
          />
          <Button
            kind="ghost"
            size="small"
            label={settingsRes.string.ApiKeyAddAll}
            disabled={events.length === webhookEventTypes.length}
            on:click={() => {
              events = [...webhookEventTypes]
            }}
          />
        </div>
      </div>
      <div class="hint"><Label label={settingsRes.string.WebhookEventsHint} /></div>
      {#if events.length > 0}
        <div class="chips">
          {#each events as type (type)}
            <Chip
              label={$webhookEventNames[type] ?? type}
              isRemovable
              on:remove={() => {
                events = events.filter((t) => t !== type)
              }}
            />
          {/each}
          <Button
            kind="ghost"
            size="small"
            label={ui.string.Clear}
            on:click={() => {
              events = []
            }}
          />
        </div>
      {/if}
    </div>

    {#if error}
      <div class="hint warn">{error}</div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }
  .hint {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }
  .warn {
    color: var(--theme-error-color);
  }
</style>
