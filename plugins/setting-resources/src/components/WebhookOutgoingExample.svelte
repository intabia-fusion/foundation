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
  import { type Class, type Doc, type Ref } from '@hcengineering/core'
  import { copyTextToClipboard } from '@hcengineering/presentation'
  import { webhookEventSamples } from '@hcengineering/setting'
  import {
    Button,
    DropdownLabels,
    Icon,
    IconCopy,
    Label,
    Scroller,
    eventToHTMLElement,
    showPopup,
    type DropdownTextItem
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import settingsRes from '../plugin'
  import { webhookEventLabels, webhookEventTypes, type WebhookEventType } from '../webhookEvents'
  import WebhookTargetPicker from './WebhookTargetPicker.svelte'

  // Class ids as string literals, like the incoming example - this package must not depend on tracker.
  const issueClass = 'tracker:class:Issue' as Ref<Class<Doc>>
  const documentClass = 'document:class:Document' as Ref<Class<Doc>>

  interface TargetLike extends Doc {
    identifier?: string
    name?: string
    title?: string
  }

  let eventType: WebhookEventType = webhookEventTypes[0]
  const eventItems: DropdownTextItem[] = webhookEventTypes.map((t) => ({ id: t, label: t }))

  // Which document kind fills the sample for this event. Events whose payload carries no document
  // identity of its own (a comment, a chat message) take none.
  function eventTargetClass (type: WebhookEventType): Ref<Class<Doc>> | undefined {
    if (type.startsWith('issue.') && !type.includes('comment') && !type.includes('time_report')) return issueClass
    if (type === 'document.created') return documentClass
    return undefined
  }

  let target: TargetLike | undefined
  let lastEventType: WebhookEventType | undefined
  $: eventClass = eventTargetClass(eventType)
  // A document picked for the previous event no longer belongs in this one's payload.
  $: if (eventType !== lastEventType) {
    lastEventType = eventType
    target = undefined
  }
  $: targetLabel = target !== undefined ? (target.name ?? target.title ?? target.identifier ?? '') : undefined

  function pickTarget (event: MouseEvent, _class: Ref<Class<Doc>>): void {
    showPopup(
      WebhookTargetPicker,
      { _class, searchField: 'title', selected: target?._id },
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

  // Real ids from a picked document, so the sample matches what a receiver will actually get.
  function buildSample (type: WebhookEventType, doc: TargetLike | undefined): Record<string, unknown> {
    const sample = webhookEventSamples[type]
    if (doc === undefined) return sample
    const data = { ...(sample.data as Record<string, unknown>) }
    data.id = doc._id
    if (data.identifier !== undefined && doc.identifier !== undefined) data.identifier = doc.identifier
    if (data.title !== undefined && (doc.title ?? doc.name) !== undefined) data.title = doc.title ?? doc.name
    return { ...sample, data }
  }

  $: sample = buildSample(eventType, target)
</script>

<div class="hulyComponent-content__container columns">
  <div class="hulyComponent-content__column content">
    <Scroller align="center" padding="var(--spacing-3)" bottomPadding="var(--spacing-3)">
      <div class="hulyComponent-content gap">
        <div class="hulyTableAttr-container">
          <div class="hulyTableAttr-header font-medium-12">
            <Icon icon={settingsRes.icon.Integrations} size="small" />
            <span><Label label={settingsRes.string.WebhookExamplesOutgoing} /></span>
          </div>
          <div class="hulyTableAttr-content section">
            <div class="pickers">
              <div class="flex-col flex-gap-1">
                <Label label={settingsRes.string.WebhookEventsLabel} />
                <DropdownLabels
                  items={eventItems}
                  bind:selected={eventType}
                  kind="regular"
                  size="medium"
                  justify="left"
                />
              </div>
              {#if eventClass !== undefined}
                {@const cls = eventClass}
                <div class="flex-col flex-gap-1">
                  <Label label={settingsRes.string.WebhookConstructTarget} />
                  <Button
                    kind="regular"
                    size="medium"
                    justify="left"
                    on:click={(ev) => {
                      pickTarget(ev, cls)
                    }}
                  >
                    <svelte:fragment slot="content">
                      {#if targetLabel !== undefined}
                        {targetLabel}
                      {:else}
                        <Label label={settingsRes.string.WebhookConstructPickTarget} />
                      {/if}
                    </svelte:fragment>
                  </Button>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <div class="hulyTableAttr-container">
          <div class="hulyTableAttr-header font-medium-12">
            <Icon icon={settingsRes.icon.Setting} size="small" />
            <span><Label label={settingsRes.string.WebhookExamplePayload} /></span>
          </div>
          <div class="hulyTableAttr-content section">
            <div class="exampleCard">
              <div class="flex-row-center flex-between">
                <span class="opLabel"><Label label={webhookEventLabels[eventType]} /></span>
                <Button
                  kind="ghost"
                  size="small"
                  icon={IconCopy}
                  showTooltip={{ label: view.string.CopyToClipboard }}
                  on:click={() => {
                    void copyText(JSON.stringify(sample, null, 2))
                  }}
                />
              </div>
              <pre class="samplePayload">{JSON.stringify(sample, null, 2)}</pre>
            </div>
          </div>
        </div>
      </div>
    </Scroller>
  </div>
</div>

<style lang="scss">
  .section {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    gap: 0.75rem;
    padding: var(--spacing-2);
  }
  .pickers {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .opLabel {
    font-family: monospace;
  }
  .exampleCard {
    padding: 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
  }
  .samplePayload {
    max-width: 100%;
    max-height: 24rem;
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
