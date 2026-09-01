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
  import { apiKeyOperations, type ApiKeyOperation } from '@hcengineering/account-client'
  import { concatLink, type Class, type Doc, type DocumentQuery, type Ref } from '@hcengineering/core'
  import { getMetadata, type IntlString } from '@hcengineering/platform'
  import presentation, { copyTextToClipboard } from '@hcengineering/presentation'
  import setting from '@hcengineering/setting'
  import {
    Button,
    DropdownLabels,
    IconCopy,
    Label,
    Modal,
    eventToHTMLElement,
    showPopup,
    type DropdownTextItem
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { createEventDispatcher } from 'svelte'
  import settingsRes from '../plugin'
  import WebhookTargetPicker from './WebhookTargetPicker.svelte'

  // Class ids as string literals - the same escape hatch export-resources/ExportSettings.svelte uses
  // to avoid a tracker/chunter/document dependency, which is forbidden here.
  const projectClass = 'tracker:class:Project' as Ref<Class<Doc>>
  const issueClass = 'tracker:class:Issue' as Ref<Class<Doc>>
  const channelClass = 'chunter:class:Channel' as Ref<Class<Doc>>
  const teamspaceClass = 'document:class:Teamspace' as Ref<Class<Doc>>
  const documentClass = 'document:class:Document' as Ref<Class<Doc>>

  const PLACEHOLDER_KEY = '<API_KEY>'

  const dispatch = createEventDispatcher()

  let op: ApiKeyOperation = apiKeyOperations[0]
  const opItems: DropdownTextItem[] = apiKeyOperations.map((o) => ({ id: o, label: o }))

  interface TargetLike extends Doc {
    identifier?: string
    name?: string
    title?: string
  }

  /** What each operation's `space` field names, so only targets of that kind can be picked. */
  interface TargetKind {
    _class: Ref<Class<Doc>>
    docQuery?: DocumentQuery<Doc>
    searchField: string
    // Field substituted into the example - the same value the transactor's resolver looks up.
    field: 'identifier' | 'name' | 'title'
    placeholder: string
    hint: IntlString
  }

  function targetKind (op: ApiKeyOperation): TargetKind {
    switch (op) {
      case 'issue:create':
        return {
          _class: projectClass,
          searchField: 'name',
          field: 'identifier',
          placeholder: '<PROJECT_IDENTIFIER>',
          hint: settingsRes.string.WebhookIncomingPlaceholderProject
        }
      case 'issue:update':
      case 'issue:comment':
      case 'issue:time_report':
        return {
          _class: issueClass,
          searchField: 'title',
          field: 'identifier',
          placeholder: '<ISSUE_IDENTIFIER>',
          hint: settingsRes.string.WebhookIncomingPlaceholderIssue
        }
      case 'chat:post':
        return {
          _class: channelClass,
          searchField: 'name',
          field: 'name',
          placeholder: '<CHANNEL_NAME>',
          hint: settingsRes.string.WebhookIncomingPlaceholderChannel
        }
      case 'doc:create':
        return {
          _class: teamspaceClass,
          searchField: 'name',
          field: 'name',
          placeholder: '<TEAMSPACE_NAME>',
          hint: settingsRes.string.WebhookIncomingPlaceholderTeamspace
        }
      case 'doc:update':
        return {
          _class: documentClass,
          searchField: 'title',
          field: 'title',
          placeholder: '<DOCUMENT_TITLE>',
          hint: settingsRes.string.WebhookIncomingPlaceholderDocument
        }
    }
  }

  let target: TargetLike | undefined
  $: kind = targetKind(op)
  // The kind changes with the operation, so a target picked for the previous one no longer applies.
  $: if (kind._class !== undefined) target = undefined
  $: targetValue = target?.[kind.field]
  $: targetLabel = target !== undefined ? (target.name ?? target.title ?? target.identifier ?? '') : undefined

  const serviceUrl = getMetadata(setting.metadata.WebhookServiceUrl) ?? ''
  $: headerEndpoint = `POST ${concatLink(serviceUrl, '/api/v1/webhook/action')}`
  // No live key/token ever appears here - examples get pasted into tickets and chats, and one carrying
  // a real credential would leak it. Only the placeholder and the header/path shape are shown.
  $: pathEndpoint = `POST ${concatLink(serviceUrl, `/api/v1/webhook/k/${PLACEHOLDER_KEY}`)}`

  function pickTarget (event: MouseEvent): void {
    showPopup(
      WebhookTargetPicker,
      { _class: kind._class, docQuery: kind.docQuery, searchField: kind.searchField, selected: target?._id },
      eventToHTMLElement(event),
      (result?: Doc) => {
        if (result !== undefined) target = result as TargetLike
      }
    )
  }

  async function copyText (text: string): Promise<void> {
    if (!window.isSecureContext) return
    await copyTextToClipboard(text)
  }

  interface Example {
    op: ApiKeyOperation
    json: Record<string, unknown>
    hint?: IntlString
  }

  function buildExample (op: ApiKeyOperation, space: string | undefined): Example {
    const hint = space === undefined ? targetKind(op).hint : undefined
    const value = space ?? targetKind(op).placeholder
    switch (op) {
      case 'issue:create':
        return {
          op,
          json: {
            action: op,
            space: value,
            title: 'Payment webhook retries indefinitely',
            body: '## Steps to reproduce\n\n1. Trigger a webhook delivery\n2. Watch it retry forever'
          },
          hint
        }
      case 'issue:update':
        return {
          op,
          json: {
            action: op,
            space: value,
            title: 'Payment webhook stops retrying after fix',
            body: 'Confirmed fixed after deploying the retry-cap change.'
          },
          hint
        }
      case 'issue:comment':
        return {
          op,
          json: { action: op, space: value, message: 'Reproduced on staging, looking into the retry loop now.' },
          hint
        }
      case 'issue:time_report':
        return {
          op,
          json: {
            action: op,
            space: value,
            employee: 'user@example.com',
            date: '2026-09-03',
            hours: 2.5,
            description: 'Investigated the retry loop'
          },
          hint
        }
      case 'chat:post':
        return { op, json: { action: op, space: value, message: 'Deploy finished, all green.' }, hint }
      case 'doc:create':
        return {
          op,
          json: {
            action: op,
            space: value,
            title: 'Q3 Roadmap',
            body: '# Roadmap\n\nMarkdown content for the new document.'
          },
          hint
        }
      case 'doc:update':
        return {
          op,
          json: { action: op, space: value, title: 'Q3 Roadmap (revised)', body: 'Updated markdown content.' },
          hint
        }
    }
  }

  $: example = buildExample(op, targetValue)
</script>

<Modal
  label={settingsRes.string.WebhookConstruct}
  type="type-popup"
  width="medium"
  okLabel={presentation.string.Close}
  okAction={() => {
    dispatch('close')
  }}
  canSave
  showCancelButton={false}
  onCancel={() => {
    dispatch('close')
  }}
>
  <div class="flex-col-stretch flex-gap-4">
    <div class="hint"><Label label={settingsRes.string.WebhookConstructHint} /></div>

    <div class="flex-col flex-gap-2">
      <Label label={settingsRes.string.WebhookConstructOperation} />
      <DropdownLabels items={opItems} bind:selected={op} kind="regular" size="medium" justify="left" />
    </div>

    <div class="flex-col flex-gap-2">
      <Label label={settingsRes.string.WebhookConstructTarget} />
      <Button kind="regular" size="medium" justify="left" on:click={pickTarget}>
        <svelte:fragment slot="content">
          {#if targetLabel !== undefined}
            {targetLabel}
          {:else}
            <Label label={settingsRes.string.WebhookConstructPickTarget} />
          {/if}
        </svelte:fragment>
      </Button>
    </div>

    <div class="flex-col flex-gap-2">
      <div class="sectionTitle"><Label label={settingsRes.string.WebhookIncomingEndpoint} /></div>
      <div class="endpointLine">
        <div class="hint"><Label label={settingsRes.string.WebhookIncomingEndpointHeaderAuth} /></div>
        <div class="flex-row-center flex-gap-2">
          <code class="endpointUrl">{headerEndpoint}</code>
          <Button
            kind="ghost"
            size="small"
            icon={IconCopy}
            showTooltip={{ label: view.string.CopyToClipboard }}
            on:click={() => {
              void copyText(headerEndpoint)
            }}
          />
        </div>
      </div>
      <div class="endpointLine">
        <div class="hint"><Label label={settingsRes.string.WebhookIncomingEndpointPathAuth} /></div>
        <div class="flex-row-center flex-gap-2">
          <code class="endpointUrl">{pathEndpoint}</code>
          <Button
            kind="ghost"
            size="small"
            icon={IconCopy}
            showTooltip={{ label: view.string.CopyToClipboard }}
            on:click={() => {
              void copyText(pathEndpoint)
            }}
          />
        </div>
      </div>
    </div>

    <div class="exampleCard">
      <div class="flex-row-center flex-between">
        <span class="opLabel">{example.op}</span>
        <Button
          kind="ghost"
          size="small"
          icon={IconCopy}
          showTooltip={{ label: view.string.CopyToClipboard }}
          on:click={() => {
            void copyText(JSON.stringify(example.json, null, 2))
          }}
        />
      </div>
      {#if example.hint}
        <div class="hint warn"><Label label={example.hint} /></div>
      {/if}
      <pre class="samplePayload">{JSON.stringify(example.json, null, 2)}</pre>
    </div>
  </div>
</Modal>

<style lang="scss">
  .sectionTitle {
    font-weight: 500;
  }
  .hint {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }
  .warn {
    color: var(--theme-error-color);
  }
  .opLabel {
    font-family: monospace;
  }
  .endpointLine {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .endpointUrl {
    font-family: monospace;
    font-size: 0.8125rem;
    word-break: break-all;
  }
  .exampleCard {
    padding: 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
  }
  .samplePayload {
    max-width: 100%;
    max-height: 16rem;
    overflow: auto;
    margin: 0.375rem 0 0;
    padding: 0.5rem;
    font-family: monospace;
    font-size: 0.75rem;
    background: var(--theme-bg-color);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;
  }
</style>
