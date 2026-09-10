<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import activity, { ActivityMessage, ActivityMessageViewType } from '@hcengineering/activity'
  import {
    ActivityDocLink,
    ActivityMessageTemplate,
    MessageInlineAction,
    editingMessageStore
  } from '@hcengineering/activity-resources'
  import { Attachment } from '@hcengineering/attachment'
  import { AttachmentDocList, AttachmentImageSize } from '@hcengineering/attachment-resources'
  import chunter, { ChatMessage } from '@hcengineering/chunter'
  import contact, { Employee, getCurrentEmployee, Person, SocialIdentity } from '@hcengineering/contact'
  import { CombineAvatars, getPersonByPersonIdCb, getSocialIdByPersonIdCb } from '@hcengineering/contact-resources'
  import { AccountUuid, Class, Doc, Markup, Ref, Space, WithLookup } from '@hcengineering/core'
  import { getClient, MessageViewer, pendingCreatedDocs } from '@hcengineering/presentation'
  import { EmptyMarkup } from '@hcengineering/text'
  import { Action, Button, IconEdit, languageStore, deviceOptionsStore } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { getDocLinkTitle } from '@hcengineering/view-resources'
  import { NotificationClientImpl } from '@hcengineering/notification-resources'

  import { shownTranslatedMessagesStore, translatedMessagesStore, translatingMessagesStore } from '../../stores'
  import ChatMessageInput from './ChatMessageInput.svelte'
  import DoubleCheck from '../icons/DoubleCheck.svelte'
  import MessageReadMarker from './MessageReadMarker.svelte'
  import MessageReadPopup from './MessageReadPopup.svelte'
  import ForwardedMessagePresenter from '../ForwardedMessagePresenter.svelte'
  import { replyToMessage } from '../../utils'

  export let value: WithLookup<ChatMessage> | undefined
  export let doc: Doc | undefined = undefined
  export let showNotify: boolean = false
  export let isHighlighted: boolean = false
  export let isSelected: boolean = false
  export let shouldScroll: boolean = false
  export let embedded: boolean = false
  export let withActions: boolean = true
  export let showEmbedded = false
  export let hideFooter = false
  export let skipLabel = false
  export let actions: Action[] = []
  export let hoverable = true
  export let inline = false
  export let hoverStyles: 'filledHover' = 'filledHover'
  export let attachmentImageSize: AttachmentImageSize = 'x-large'
  export let videoPreload = false
  export let readonly = false
  export let type: ActivityMessageViewType = 'default'
  export let padding: string | null = null
  export let timeFormat: 'time' | 'full' = 'time'
  export let onClick: (() => void) | undefined = undefined
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const STALE_TIMEOUT_MS = 5000
  const me = getCurrentEmployee()

  let parentMessage: ActivityMessage | undefined = undefined
  let object: Doc | undefined

  let refInput: ChatMessageInput

  $: personId = value?.createdBy
  let person: Person | undefined
  let socialId: SocialIdentity | undefined
  $: if (personId !== undefined) {
    getPersonByPersonIdCb(personId, (p) => {
      person = p ?? undefined
    })
    getSocialIdByPersonIdCb(personId, (s) => {
      socialId = s ?? undefined
    })
  } else {
    person = undefined
    socialId = undefined
  }

  let originalText = value?.message

  $: if (value && originalText && originalText !== value?.message) {
    originalText = value.message
    translatedMessagesStore.update((map) => {
      if (value) {
        map.delete(value._id)
      }
      return map
    })
    shownTranslatedMessagesStore.update((map) => {
      if (value) {
        map.delete(value._id)
      }
      return map
    })
  } else {
    originalText = value?.message
  }

  $: value !== undefined &&
    getParentMessage(value.attachedToClass, value.attachedTo, value.space).then((res) => {
      parentMessage = res
    })

  $: if (doc !== undefined && value?.attachedTo === doc._id) {
    object = doc
  } else if (value !== undefined) {
    void client.findOne(value.attachedToClass, { _id: value.attachedTo }).then((result) => {
      object = result
    })
  }

  let stale = false
  let markStaleId: NodeJS.Timeout | undefined
  $: pending = value?._id !== undefined && $pendingCreatedDocs[value._id]
  $: if (pending) {
    markStaleId = setTimeout(() => {
      stale = true
    }, STALE_TIMEOUT_MS)
  } else {
    if (markStaleId !== undefined) {
      clearTimeout(markStaleId)
      markStaleId = undefined
    }
    stale = false
  }

  async function getParentMessage (
    _class: Ref<Class<Doc>>,
    _id: Ref<Doc>,
    space: Ref<Space>
  ): Promise<ActivityMessage | undefined> {
    if (hierarchy.isDerived(_class, activity.class.ActivityMessage)) {
      return await client.findOne<ActivityMessage>(_class, { _id: _id as Ref<ActivityMessage>, space })
    }
  }

  async function handleEditAction (): Promise<void> {
    if (value == null) return
    editingMessageStore.set(value._id)
  }

  const inboxClient = NotificationClientImpl.getClient()
  const readStateByDocStore = inboxClient.readStateByDoc

  $: if (value != null) {
    void inboxClient.loadReadState(value.attachedTo)
  }

  $: readState = value != null ? $readStateByDocStore.get(value.attachedTo) : undefined

  let readEmployees = new Map<AccountUuid, Employee>()

  let isEditing = false
  $: isEditing = $editingMessageStore === value?._id
  let additionalActions: Action[] = []

  $: isOwn = person?._id === me

  $: additionalActions = [
    ...(isOwn
      ? [
          {
            label: activity.string.Edit,
            icon: IconEdit,
            group: 'edit',
            action: handleEditAction,
            order: 1
          }
        ]
      : []),

    ...(readEmployees.size > 0
      ? [
          {
            label: chunter.string.Seen,
            icon: DoubleCheck,
            group: 'tools',
            component: MessageReadPopup,
            inlineComponent: CombineAvatars,
            inlineComponentProps: {
              _class: contact.class.Person,
              items: Array.from(readEmployees.values()).map((it) => it._id),
              size: 'tiny'
            },
            props: { value: Array.from(readEmployees.values()) },
            action: async () => {}
          }
        ]
      : []),
    ...actions
  ]

  let attachments: Attachment[] | undefined = undefined
  $: attachments = value?.$lookup?.attachments as Attachment[] | undefined

  let inlineActions: MessageInlineAction[] = []

  $: updateInlineActions($translatingMessagesStore, $shownTranslatedMessagesStore)
  function updateInlineActions (
    translatingMessages: Set<Ref<ChatMessage>>,
    shownTranslated: Set<Ref<ChatMessage>>
  ): void {
    if (value === undefined) {
      inlineActions = []
      return
    }

    const result: MessageInlineAction[] = []

    if (translatingMessages.has(value._id)) {
      result.push({
        label: chunter.string.Translating
      })
    } else if (shownTranslated.has(value._id)) {
      result.push({
        label: chunter.string.ShowOriginal,
        onClick: async () => {
          shownTranslatedMessagesStore.update((map) => {
            if (value) {
              map.delete(value._id)
            }
            return map
          })
        }
      })
    }

    inlineActions = result
  }

  $: socialProvider = value?.provider
    ? client.getModel().findAllSync(contact.class.ChannelProvider, { _id: value.provider })[0]
    : undefined

  let displayText: Markup = value?.message ?? EmptyMarkup

  $: if (value && $shownTranslatedMessagesStore.has(value._id)) {
    displayText = $translatedMessagesStore.get(value._id) ?? value?.message ?? EmptyMarkup
  } else {
    displayText = value?.message ?? EmptyMarkup
  }

  async function handleDbClick (e: MouseEvent): Promise<void> {
    if ($deviceOptionsStore.isMobile) return
    if (isEditing || value == null) return

    const target = e.target as HTMLElement | null
    if (
      target?.closest(
        '.replies-container, .replies, .hulyReactions-container, .reactions, .actions, .gallery, .attachment-preview, .forwarded-message, .read-marker, .avatar, .socialIcon, .saveMarker, .header, button, input, textarea, img, [role="button"]'
      )
    ) {
      return
    }

    e.preventDefault()
    e.stopPropagation()

    await replyToMessage(value)
  }
</script>

{#if inline && object}
  {#await getDocLinkTitle(client, object._id, object._class, object, $languageStore) then title}
    <ActivityDocLink
      {object}
      {title}
      panelComponent={hierarchy.classHierarchyMixin(object._class, view.mixin.ObjectPanel)?.component ??
        view.component.EditDoc}
    />
  {/await}
{:else if value && !inline}
  <ActivityMessageTemplate
    message={value}
    {parentMessage}
    {person}
    socialId={socialId?.type !== 'huly' ? socialId : undefined}
    {showNotify}
    {isHighlighted}
    {isSelected}
    {shouldScroll}
    {embedded}
    withActions={withActions && !isEditing}
    actions={additionalActions}
    {showEmbedded}
    {hideFooter}
    {hoverable}
    {hoverStyles}
    {skipLabel}
    {pending}
    {stale}
    {readonly}
    excludedActions={$shownTranslatedMessagesStore.has(value._id)
      ? [chunter.action.TranslateMessage]
      : [chunter.action.ShowOriginalMessage]}
    socialIcon={socialProvider?.icon}
    {inlineActions}
    {type}
    {padding}
    {timeFormat}
    {onClick}
    {onReply}
    on:dblclick={handleDbClick}
  >
    <svelte:fragment slot="afterTime">
      {#if !pending && isOwn && readState}
        <div class="read-marker" class:center={type !== 'short'}>
          <MessageReadMarker bind:readEmployees createdOn={value.createdOn ?? value.modifiedOn} {readState} />
        </div>
      {/if}
    </svelte:fragment>
    <svelte:fragment slot="content">
      {#if !isEditing}
        <div class="clear-mins" {...!pending && { 'data-delivered': true }}>
          <MessageViewer message={displayText} />
          {#if (value.attachments ?? 0) > 0}
            <div class="mt-2" />
          {/if}
          <AttachmentDocList {value} {attachments} imageSize={attachmentImageSize} {videoPreload} {isOwn} />
          <ForwardedMessagePresenter parent={value} {object} />
        </div>
      {:else if object}
        <ChatMessageInput
          bind:this={refInput}
          chatMessage={value}
          shouldSaveDraft={false}
          focusIndex={1000}
          autofocus
          {object}
          on:submit={() => {
            editingMessageStore.set(undefined)
          }}
        />
        <div class="flex-row-center gap-2 justify-end mt-2">
          <Button
            label={view.string.Cancel}
            on:click={() => {
              editingMessageStore.set(undefined)
            }}
          />
          <Button label={activity.string.Update} accent on:click={() => refInput.submit()} />
        </div>
      {/if}
    </svelte:fragment>
  </ActivityMessageTemplate>
{/if}

<style lang="scss">
  .read-marker {
    display: flex;
    margin-left: 0.25rem;
    max-height: 1.25rem;

    &.center {
      margin-bottom: 0.125rem;
      align-items: center;
    }
  }
  .forwarded-header {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    color: var(--global-subtle-ui-Color);
    margin-bottom: 4px;
  }
  .reply-block {
    border-left: 2px solid var(--global-brand-BackgroundColor);
    background: var(--global-surface-01-BackgroundColor);
    padding: 4px 8px;
    margin-bottom: 6px;
    border-radius: 4px;
  }
  .reply-author {
    font-weight: 500;
    font-size: 0.85em;
    margin-bottom: 2px;
  }
  .reply-text {
    font-size: 0.85em;
    color: var(--global-subtle-ui-Color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-height: 2em;
  }
</style>
