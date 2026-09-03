<!--
// Copyright © 2026 Intabia Fusion.
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
  import { EditWithIcon, IconSearch, Modal, deviceOptionsStore, Label } from '@hcengineering/ui'
  import activity from '@hcengineering/activity'
  import presentation, { getClient } from '@hcengineering/presentation'
  import { Doc, getCurrentAccount, Markup, WithLookup } from '@hcengineering/core'
  import { EmptyMarkup } from '@hcengineering/text'
  import { getSpace } from '@hcengineering/activity-resources'
  import { ChatMessage, createAndGetDirect } from '@hcengineering/chunter'
  import contact, { Employee } from '@hcengineering/contact'
  import { createEventDispatcher } from 'svelte'

  import chunter from '../plugin'
  import ChatsList from './ChatsList.svelte'
  import ChatMessageInputLite from './chat-message/ChatMessageInputLite.svelte'
  import ReplyToMessagePresenter from './ReplyToMessagePresenter.svelte'
  import ChatModernTab from './ChatModernTab.svelte'
  import { getForwardData } from '../utils'

  export let message: WithLookup<ChatMessage>

  const dispatch = createEventDispatcher()
  const me = getCurrentAccount()

  let search: string = ''
  let selectedDocs: Doc[] = []
  let markup: Markup = EmptyMarkup

  let forwarding = false

  async function handleForward (): Promise<void> {
    if (forwarding) return
    try {
      forwarding = true
      const client = getClient()
      const hierarchy = client.getHierarchy()
      const op = client.apply('forward-message')
      const forwardData = await getForwardData(message)
      for (const _doc of selectedDocs) {
        const isEmployee = hierarchy.hasMixin(_doc, contact.mixin.Employee)
        const employee = isEmployee ? (_doc as Employee) : undefined
        const account = employee?.personUuid
        const doc = account != null ? await createAndGetDirect(client, [account, me.uuid]) : _doc
        if (doc == null) continue

        await op.addCollection<Doc, ChatMessage>(
          chunter.class.ChatMessage,
          getSpace(doc),
          doc._id,
          doc._class,
          'comments',
          {
            message: markup,
            ...forwardData
          }
        )
      }
      await op.commit()
      dispatch('close')
    } finally {
      forwarding = false
    }
  }

  function handleClose (): void {
    dispatch('close')
  }

  $: canSave = selectedDocs.length > 0 && !forwarding

  let count = 0
  let height: number = 0
  let loading: boolean = true
  $: height = Math.max(height, count * 2.75, 3)

  let empty = false
</script>

<Modal
  label={chunter.string.ForwardMessage}
  type="type-popup"
  okLabel={activity.string.Forward}
  okLoading={forwarding}
  okAction={handleForward}
  {canSave}
  maxWidth="40rem"
  scrollableContent={false}
  onCancel={handleClose}
  on:close={handleClose}
>
  <div class="forward-modal">
    <div class="forward-modal__selected-chats">
      <span class="forward-modal__to-whom">
        <Label label={chunter.string.ToWhom} />:
      </span>
      {#each selectedDocs as doc (doc._id)}
        <ChatModernTab
          {doc}
          on:close={() => {
            selectedDocs = selectedDocs.filter((it) => it._id !== doc._id)
          }}
        />
      {/each}
    </div>
    <div class="forward-modal__search">
      <EditWithIcon
        icon={IconSearch}
        size="large"
        width="100%"
        autoFocus={!$deviceOptionsStore.isMobile}
        bind:value={search}
        on:change={() => dispatch('search', search)}
        on:input={() => dispatch('search', search)}
        placeholder={presentation.string.Search}
      />
    </div>

    <div class="forward-modal__line mt-2" />

    <div class="forward-modal__chats" style="height: {height}rem" style:min-height="{height}rem">
      {#if empty}
        <div class="forward-modal__no-results">
          <Label label={chunter.string.NoResults} />
        </div>
      {/if}
      <ChatsList
        {search}
        limit={8}
        bind:selectedDocs
        bind:empty
        bind:loading
        bind:count
        on:select={(e) => {
          selectedDocs = e.detail ?? []
        }}
      />
    </div>
    <div class="forward-modal__line mb-2" />

    <div class="forward-modal__message">
      <ReplyToMessagePresenter replyTo={message} labelIntl={activity.string.ForwardedMessageFrom} canClose={false} />
    </div>
    <div class="forward-modal__input">
      <ChatMessageInputLite
        disableSubmit={!canSave}
        clearOnSubmit={false}
        on:update={(e) => {
          markup = e.detail.message
        }}
        on:message={handleForward}
      />
    </div>
  </div>
</Modal>

<style lang="scss">
  .forward-modal {
    position: relative;
    display: flex;
    flex-direction: column;
    max-width: 60rem;
    max-height: 60rem;
    min-height: 20rem;
    gap: 0.5rem;
    padding: 1rem 0;

    &__line {
      width: 100%;
      height: 1px;
      background: var(--global-subtle-ui-BorderColor);
    }

    &__chats {
      display: flex;
      flex-direction: column;
      min-height: 3rem;
      padding: 0 1.5rem;
    }

    &__selected-chats {
      display: flex;
      flex-wrap: wrap;
      column-gap: 0.25rem;
      row-gap: 0.25rem;
      min-height: 1.75rem;
      margin: 0.25rem 0;
      align-items: center;
      padding: 0 1.5rem;
    }

    &__to-whom {
      font-weight: 500;
      white-space: nowrap;
    }

    &__search {
      padding: 0 1.5rem;
      width: 100%;
    }

    &__message {
      padding: 0 1.5rem;
      width: 100%;
    }
    &__input {
      padding: 0 1.5rem;
      width: 100%;
    }

    &__no-results {
      height: 100%;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--global-secondary-TextColor);
    }
  }
</style>
