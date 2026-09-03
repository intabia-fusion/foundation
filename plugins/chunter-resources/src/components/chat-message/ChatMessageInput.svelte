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
  import activity, { ActivityMessage } from '@hcengineering/activity'
  import { Analytics } from '@hcengineering/analytics'
  import { AttachmentRefInput } from '@hcengineering/attachment-resources'
  import chunter, { ChatMessage, ChunterEvents, ThreadMessage } from '@hcengineering/chunter'
  import core, {
    Class,
    Doc,
    generateId,
    getCurrentAccount,
    Ref,
    type CommitResult,
    Markup,
    WithLookup,
    DocumentUpdate,
    Space
  } from '@hcengineering/core'
  import { createQuery, DraftController, draftsStore, getClient } from '@hcengineering/presentation'
  import { EmptyMarkup, isEmptyMarkup } from '@hcengineering/text'
  import { RefAction } from '@hcengineering/text-editor'
  import { Attachment } from '@hcengineering/attachment'
  import { createEventDispatcher, onDestroy } from 'svelte'
  import { getObjectId } from '@hcengineering/view-resources'
  import { ThrottledCaller } from '@hcengineering/ui'
  import { getSpace, editingMessageStore } from '@hcengineering/activity-resources'
  import { setTyping, clearTyping } from '@hcengineering/presence-resources'

  import ReplyToMessagePresenter from '../ReplyToMessagePresenter.svelte'
  import { getChannelSpace, getForwardData } from '../../utils'
  import { replyingToMessageStore } from '../../stores'
  import ChannelTypingInfo from '../ChannelTypingInfo.svelte'
  import AIRequestProgress from '../AIRequestProgress.svelte'
  import VoiceRecordingHud from './VoiceRecordingHud.svelte'
  import IconMic from '../icons/IconMic.svelte'

  export let object: Doc
  export let chatMessage: ChatMessage | undefined = undefined
  export let shouldSaveDraft: boolean = true
  export let focusIndex: number = -1
  export let boundary: HTMLElement | undefined = undefined
  export let loading = false
  export let collection: string = 'comments'
  export let autofocus = false
  export let withTypingInfo = false
  export let onKeyDown: ((e: KeyboardEvent) => void) | undefined = undefined

  type MessageDraft = Pick<ChatMessage, '_id' | 'message' | 'attachments' | 'forwardedMessage'>

  const dispatch = createEventDispatcher()

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const _class: Ref<Class<ChatMessage>> = hierarchy.isDerived(object._class, activity.class.ActivityMessage)
    ? chunter.class.ThreadMessage
    : chunter.class.ChatMessage
  const createdMessageQuery = createQuery()
  const replyMessageQuery = createQuery()

  const draftKey = `${object._id}_${_class}`
  const draftController = new DraftController<MessageDraft>(draftKey)
  const currentDraft = shouldSaveDraft ? $draftsStore[draftKey] : undefined

  const emptyMessage: Pick<MessageDraft, 'message' | 'attachments' | 'forwardedMessage'> = {
    message: EmptyMarkup,
    attachments: 0,
    forwardedMessage: undefined
  }

  let inputRef: AttachmentRefInput
  let currentMessage: MessageDraft = chatMessage ?? currentDraft ?? getDefault()
  let _id = currentMessage._id
  let inputContent = currentMessage.message

  let recording = false
  const voiceActions: RefAction[] = [
    {
      label: chunter.string.RecordVoice,
      icon: IconMic,
      order: 2000,
      action: () => {
        recording = true
      }
    }
  ]

  // Register the HUD-created AudioTranscribe as a draft attachment (not injected into the input).
  function onAudioAttachment (e: CustomEvent<Attachment>): void {
    inputRef?.addAttachmentDoc(e.detail)
  }

  let forwardedMessage: WithLookup<ChatMessage> | undefined = undefined

  $: forwardedMessageId = chatMessage ? chatMessage.forwardedMessage : currentMessage.forwardedMessage

  $: if (
    forwardedMessage == null &&
    forwardedMessageId != null &&
    forwardedMessageId === $replyingToMessageStore?._id
  ) {
    forwardedMessage = $replyingToMessageStore as WithLookup<ChatMessage>
  }

  $: if (forwardedMessageId !== undefined) {
    replyMessageQuery.query(chunter.class.ChatMessage, { _id: forwardedMessageId as Ref<ChatMessage> }, (res) => {
      if (chatMessage === undefined) {
        replyingToMessageStore.set(res[0])
      }

      forwardedMessage = res[0]
    })
  } else {
    replyMessageQuery.unsubscribe()
    forwardedMessage = undefined
  }

  $: if (currentDraft != null) {
    createdMessageQuery.query(_class, { _id, space: getSpace(object) }, (result: ChatMessage[]) => {
      if (result.length > 0 && _id !== chatMessage?._id) {
        // Ouch we have got comment with same id created already.
        clear()
      }
    })
  } else {
    createdMessageQuery.unsubscribe()
  }

  function clear (): void {
    currentMessage = getDefault()
    _id = currentMessage._id
    inputRef.removeDraft(false)
  }

  function objectChange (draft: MessageDraft, empty: Partial<MessageDraft>): void {
    if (shouldSaveDraft) {
      draftController.save(draft, empty)
    }
  }

  $: objectChange(currentMessage, emptyMessage)

  function getDefault (): MessageDraft {
    return {
      _id: generateId(),
      ...emptyMessage
    }
  }

  const acc = getCurrentAccount()
  const throttle = new ThrottledCaller(500)

  $: space = hierarchy.isDerived(object._class, core.class.Space) ? (object._id as Ref<Space>) : object.space

  async function deleteTypingInfo (): Promise<void> {
    if (!withTypingInfo) return
    void clearTyping(acc.primarySocialId, object._id)
  }

  async function updateTypingInfo (): Promise<void> {
    if (!withTypingInfo) return

    throttle.call(() => {
      void setTyping(acc.primarySocialId, object._id, space)
    })
  }

  onDestroy(() => {
    void deleteTypingInfo()
  })

  function onUpdate (event: CustomEvent<{ message: Markup, attachments: number }>): void {
    if (!isEmptyMarkup(event.detail.message)) {
      void updateTypingInfo()
    }
    if (!shouldSaveDraft) {
      return
    }
    const { message, attachments } = event.detail
    currentMessage.message = message
    currentMessage.attachments = attachments
  }

  async function handleCreate (event: CustomEvent, _id: Ref<ChatMessage>): Promise<void> {
    try {
      const res = await createMessage(event, _id, `chunter.create.${_class} ${object._class}`)

      console.log(`create.${_class} measure`, res.serverTime, res.time)
      const objectId = await getObjectId(object, client.getHierarchy())
      Analytics.handleEvent(ChunterEvents.MessageCreated, { ok: res.result, objectId, objectClass: object._class })
    } catch (err: any) {
      const objectId = await getObjectId(object, client.getHierarchy())
      Analytics.handleEvent(ChunterEvents.MessageCreated, { ok: false, objectId, objectClass: object._class })
      Analytics.handleError(err)
    }
  }

  async function handleEdit (event: CustomEvent): Promise<void> {
    try {
      await editMessage(event)
      const objectId = await getObjectId(object, client.getHierarchy())
      Analytics.handleEvent(ChunterEvents.MessageEdited, { ok: true, objectId, objectClass: object._class })
    } catch (err: any) {
      const objectId = await getObjectId(object, client.getHierarchy())
      Analytics.handleEvent(ChunterEvents.MessageEdited, { ok: false, objectId, objectClass: object._class })
      Analytics.handleError(err)
    }
  }

  async function onMessage (event: CustomEvent): Promise<void> {
    draftController.remove()
    inputRef.removeDraft(false)

    if (chatMessage !== undefined) {
      loading = true
      await handleEdit(event)
    } else {
      void handleCreate(event, _id)
      void deleteTypingInfo()
    }

    // Remove draft from Local Storage
    clear()
    if (chatMessage === undefined) {
      replyingToMessageStore.set(undefined)
    }
    dispatch('submit', false)
    loading = false
  }

  async function createMessage (event: CustomEvent, _id: Ref<ChatMessage>, msg: string): Promise<CommitResult> {
    const { message, attachments } = event.detail
    const operations = client.apply(undefined, msg)

    if (_class === chunter.class.ThreadMessage) {
      const parentMessage = object as ActivityMessage

      await operations.addCollection<ActivityMessage, ThreadMessage>(
        chunter.class.ThreadMessage,
        parentMessage.space,
        parentMessage._id,
        parentMessage._class,
        'replies',
        {
          message,
          attachments,
          objectClass: parentMessage.attachedToClass,
          objectId: parentMessage.attachedTo,
          ...(forwardedMessage != null ? await getForwardData(forwardedMessage) : {})
        },
        _id as Ref<ThreadMessage>
      )
    } else {
      await operations.addCollection<Doc, ChatMessage>(
        _class,
        getSpace(object),
        object._id,
        object._class,
        collection,
        {
          message,
          attachments,
          ...(forwardedMessage != null ? await getForwardData(forwardedMessage) : {})
        },
        _id
      )
    }
    return await operations.commit()
  }

  async function editMessage (event: CustomEvent): Promise<void> {
    if (chatMessage === undefined) {
      return
    }
    const { message, attachments } = event.detail
    const update: DocumentUpdate<ChatMessage> = { message, attachments, editedOn: Date.now() }

    const op = client.apply('edit-message')
    if (currentMessage.forwardedMessage == null && chatMessage.forwardedMessage != null) {
      await op.update(chatMessage, {
        $unset: {
          forwardedMessage: true,
          forwardFromId: true,
          forwardFromClass: true,
          forwardContent: true
        }
      })
    }

    await op.diffUpdate(chatMessage, update)
    await op.commit()
  }
  export function submit (): void {
    inputRef.submit()
  }

  function handleKeyDown (event: KeyboardEvent): boolean {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (inputRef.isEmptyDraft() && chatMessage == null) {
        onKeyDown?.(event)
      }
    }

    if (event.key === 'Escape') {
      if ($editingMessageStore !== undefined) {
        event.stopPropagation()
        event.preventDefault()
        editingMessageStore.set(undefined)
        return false
      }

      if ($replyingToMessageStore !== undefined) {
        event.stopPropagation()
        event.preventDefault()
        replyingToMessageStore.set(undefined)
        currentMessage = { ...currentMessage, forwardedMessage: undefined }
        return false
      }
    }
    return false
  }

  function handleReplyMessageDelete (): void {
    if (chatMessage === undefined) {
      replyingToMessageStore.set(undefined)
    }

    currentMessage = { ...currentMessage, forwardedMessage: undefined }
  }

  let prevReplyTo: Ref<ActivityMessage>

  $: if (
    $replyingToMessageStore?.attachedTo === object._id &&
    currentMessage.forwardedMessage !== $replyingToMessageStore._id
  ) {
    currentMessage.forwardedMessage = $replyingToMessageStore._id
  }

  $: {
    const id = $replyingToMessageStore?._id
    if (id != null && id !== prevReplyTo && inputRef != null) {
      prevReplyTo = id
      inputRef.focus()
    }
  }
</script>

{#if chatMessage === undefined}
  {#if forwardedMessage !== undefined && forwardedMessage.attachedTo === object._id}
    <ReplyToMessagePresenter replyTo={forwardedMessage} on:delete={handleReplyMessageDelete} />
  {/if}
{:else if forwardedMessage !== undefined && currentMessage.forwardedMessage === forwardedMessage._id}
  <ReplyToMessagePresenter replyTo={forwardedMessage} on:delete={handleReplyMessageDelete} />
{/if}

{#if recording}
  <VoiceRecordingHud
    objectId={_id}
    objectClass={_class}
    space={getChannelSpace(object._class, object._id, object.space)}
    on:audio={onAudioAttachment}
    on:send={() => inputRef?.submit()}
    on:close={() => (recording = false)}
  />
{/if}

<AttachmentRefInput
  {focusIndex}
  bind:this={inputRef}
  bind:content={inputContent}
  docId={object._id}
  docClass={object._class}
  {_class}
  space={getChannelSpace(object._class, object._id, object.space)}
  skipAttachmentsPreload={(currentMessage.attachments ?? 0) === 0}
  bind:objectId={_id}
  {shouldSaveDraft}
  {boundary}
  {autofocus}
  extraActions={voiceActions}
  isContentChanged={chatMessage?.forwardedMessage !== forwardedMessage?._id &&
    (!isEmptyMarkup(inputContent) || (currentMessage.attachments ?? 0) > 0 || forwardedMessage != null)}
  on:message={onMessage}
  on:update={onUpdate}
  on:focus
  on:blur
  bind:loading
  onKeyDown={handleKeyDown}
/>

{#if withTypingInfo}
  <div class="typing-row">
    <ChannelTypingInfo {object} />
    <AIRequestProgress {object} />
  </div>
{/if}

<style lang="scss">
  .typing-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
