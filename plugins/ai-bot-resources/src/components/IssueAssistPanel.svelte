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
  import { onDestroy } from 'svelte'
  import { type Class, type Doc, type Markup, type Ref, SortingOrder } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import { jsonToMarkup, markupToText } from '@hcengineering/text'
  import { markdownToMarkup } from '@hcengineering/text-markdown'
  import { Button, Component, IconAdd, Label, themeStore } from '@hcengineering/ui'
  import { translate } from '@hcengineering/platform'
  import aiBotPlugin, { type AIContextMessage, type AITaskProposalMessage } from '@hcengineering/ai-bot'
  import chunter, { type ChatMessage } from '@hcengineering/chunter'
  import contact, { formatName, type Person } from '@hcengineering/contact'
  import { Avatar } from '@hcengineering/contact-resources'

  import aiBot from '../plugin'
  import { aiBotNameStore, aiBotSocialIdentityStore } from '../utils'
  import { issueAssistFits, issueAssistOpened, issueDraftApplier } from '../stores'
  import {
    archiveConversation,
    linkConversationResult,
    resumeConversation,
    startIssueDraftConversation,
    updateConversationContext,
    type StartedConversation
  } from '../conversation'

  interface IssueDraftFields {
    title: string
    // Ready-to-use Markup: the dialog assigns it straight into the editor.
    description: Markup
    subIssues: string[]
    // tracker IssuePriority (0 none .. 4 low); the dialog maps it onto the enum.
    priority?: number
    estimation?: number
    // ISO-8601 date; the dialog turns it into a timestamp.
    dueDate?: string
    labels?: string[]
  }

  /** Current form state; the panel only reads it. */
  export let title: string = ''
  export let description: string = ''
  export let subIssues: string[] = []
  export let projectName: string | undefined = undefined
  /** The project the issue goes to: the conversation is linked to it, there is no issue yet. */
  export let objectId: Ref<Doc> | undefined = undefined
  export let objectClass: Ref<Class<Doc>> | undefined = undefined
  /** Writes the redrafted issue back into the dialog. */
  export let apply: (result: IssueDraftFields) => void
  /** Set by the dialog once the issue exists: the conversation is handed over to that issue. */
  export let created: { id: Ref<Doc>, identifier: string } | undefined = undefined
  /** Class of the object being drafted, used when the conversation is handed over. */
  export let resultClass: Ref<Class<Doc>> | undefined = undefined
  /** Bumped by the dialog when the form starts over: the finished conversation is left behind. */
  export let session: number = 0
  /** Conversation stored with the draft, so an unfinished issue reopens with its discussion. */
  export let conversationId: Ref<Doc> | undefined = undefined
  /** Reports the conversation back, for the dialog to keep in the draft. */
  export let onConversation: ((id: Ref<Doc> | undefined) => void) | undefined = undefined

  // The thread that carries this drafting session; created on the first message, kept afterwards.
  let conversation: StartedConversation | undefined = undefined
  let proposal: AITaskProposalMessage | undefined = undefined
  let applied = new Set<Ref<Doc>>()
  let bot: Person | undefined = undefined
  // Guards the reactive open: without it a re-render would start a second thread.
  let opening = false
  // Guards the reactive stamp: the dialog re-renders while the conversation stays the same.
  let stamped: Ref<Doc> | undefined
  let lastSession = 0

  const proposalQuery = createQuery()
  const botQuery = createQuery()

  // The thread carries the chat input, so it is opened together with the panel and not on the
  // first preset - otherwise the user stares at a panel with nothing to type into.
  $: if ($issueAssistOpened && conversation === undefined && objectId !== undefined) {
    void openConversation()
  }

  // An empty thread has nothing to reset: the button waits for the first message.
  let rootReplies = 0
  const rootQuery = createQuery()
  $: if (conversation !== undefined) {
    rootQuery.query(
      aiBotPlugin.class.AIContextMessage,
      { _id: conversation.messageId as Ref<AIContextMessage> },
      (res) => {
        rootReplies = res[0]?.replies ?? 0
      },
      { limit: 1 }
    )
  }

  $: if ($aiBotSocialIdentityStore !== undefined) {
    botQuery.query(
      contact.class.Person,
      { _id: $aiBotSocialIdentityStore.attachedTo },
      (res) => {
        bot = res[0]
      },
      { limit: 1 }
    )
  }

  // The proposal is rendered inside the thread by its own presenter; the panel only needs the
  // latest one to offer "apply to the form".
  $: if (conversation !== undefined) {
    proposalQuery.query(
      aiBotPlugin.class.AITaskProposalMessage,
      { attachedTo: conversation.messageId },
      (res) => {
        proposal = res[res.length - 1]
      },
      { sort: { createdOn: SortingOrder.Ascending } }
    )
  }

  function toMarkup (markdown: string): Markup {
    return jsonToMarkup(markdownToMarkup(markdown, { refUrl: 'ref://', imageUrl: '' }))
  }

  /** Markup is a JSON string: unreadable for the model, which then echoes JSON back. */
  function isMarkup (value: string): boolean {
    return value.trimStart().startsWith('{"type":"doc"')
  }

  function asText (value: string): string {
    return isMarkup(value) ? markupToText(value).trim() : value.trim()
  }

  function asMarkup (value: string): Markup {
    return isMarkup(value) ? value : toMarkup(value)
  }

  /** Opening line of the thread - the only part people read. */
  async function rootText (): Promise<Markup> {
    return toMarkup(await translate(aiBot.string.AssistIssueThreadStart, { project: projectName ?? '' }))
  }

  /**
   * The draft the conversation works on. It lives in a field of the root message, not in its
   * body: the model gets it as context on every turn, the chat stays readable.
   */
  function buildWorkingContext (): string {
    const context = ['The user is drafting an issue in the create dialog. Current state:']
    if (projectName !== undefined && projectName.trim() !== '') context.push(`PROJECT: ${projectName.trim()}`)
    context.push(`TITLE: ${title.trim()}`)
    context.push(`DESCRIPTION:\n${asText(description)}`)
    const subs = subIssues.map((s) => s.trim()).filter((s) => s !== '')
    if (subs.length > 0) context.push(`SUB-TASKS:\n${subs.map((s) => `- ${s}`).join('\n')}`)
    context.push(
      'Answer by calling edit_issue_draft with the COMPLETE updated task (full title, full markdown ' +
        'description), never with prose instead of the call and never with only the changed part.'
    )
    // These instructions are English; without this the model answers in English too.
    context.push(`Write the task itself in ${$themeStore.language}, whatever language this context is in.`)
    return context.join('\n\n')
  }

  // Editing the form updates the root, so the next question is answered against what is on screen
  // and not against the draft as it was when the panel opened.
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  $: if (conversation !== undefined && (title !== undefined || description !== undefined || subIssues.length >= 0)) {
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      void syncContext()
    }, 1500)
  }

  // The conversation outlives the dialog, so it says what it was for: an issue draft that turned
  // into this issue. `resultId` is what a history view will navigate by.
  $: if (
    created !== undefined &&
    (conversation !== undefined || conversationId !== undefined) &&
    stamped !== created.id
  ) {
    stamped = created.id
    void stampResult(created)
  }

  async function stampResult (result: { id: Ref<Doc>, identifier: string }): Promise<void> {
    if (resultClass === undefined) return
    // The panel may never have been opened in this session, but the draft still remembers the thread.
    const root = conversation ?? (await resumeConversation(conversationId as Ref<ChatMessage>))
    if (root === undefined) return
    try {
      await linkConversationResult(root, { id: result.id, class: resultClass, label: result.identifier })
      // The thread belongs to the issue now, not to this dialog.
      conversation = undefined
      proposal = undefined
      onConversation?.(undefined)
    } catch (err) {
      console.error(err)
    }
  }

  // Another draft, another conversation. `stamped` stays: clearing it re-stamps the fresh
  // conversation with the previous issue.
  $: if (session !== lastSession) {
    lastSession = session
    conversation = undefined
    proposal = undefined
    onConversation?.(undefined)
    // The next issue may not need the assistant: closed, one click away.
    issueAssistOpened.set(false)
  }

  async function syncContext (): Promise<void> {
    if (conversation === undefined) return
    try {
      await updateConversationContext(conversation, buildWorkingContext())
    } catch (err) {
      console.error(err)
    }
  }

  /**
   * The root message only opens the thread: the trigger never answers a context starter
   * top-level, so every request goes in as a thread message under it.
   */
  async function openConversation (): Promise<StartedConversation | undefined> {
    if (conversation !== undefined) return conversation
    if (objectId === undefined || objectClass === undefined) return undefined
    if (opening) return undefined
    opening = true
    try {
      // Coming back to an unfinished draft: continue where the discussion stopped.
      if (conversationId !== undefined) {
        conversation = await resumeConversation(conversationId as Ref<ChatMessage>)
      }
      if (conversation === undefined) {
        conversation = await startIssueDraftConversation(await rootText(), {
          objectId,
          objectClass,
          label: projectName ?? ''
        })
        onConversation?.(conversation?.messageId)
      }
      if (conversation !== undefined) {
        await updateConversationContext(conversation, buildWorkingContext())
      }
      return conversation
    } finally {
      opening = false
    }
  }

  /** Archive the current conversation and start fresh, like "New context" in a thread header. */
  async function resetConversation (): Promise<void> {
    if (conversation === undefined || objectId === undefined || objectClass === undefined) return
    await archiveConversation(conversation)
    proposal = undefined
    applied = new Set()
    // Straight to a fresh root, never through the reactive resume: the LiveQuery cache learns about
    // `archived` from the broadcast, after update() resolves, so a resume would reopen the old one.
    conversation = await startIssueDraftConversation(await rootText(), {
      objectId,
      objectClass,
      label: projectName ?? ''
    })
    onConversation?.(conversation?.messageId)
    if (conversation !== undefined) {
      await updateConversationContext(conversation, buildWorkingContext())
    }
  }

  // The apply button lives on the proposal card in the thread; this is what it calls.
  $: if ($issueAssistOpened) {
    issueDraftApplier.set(applyProposal)
  }
  onDestroy(() => {
    issueDraftApplier.set(undefined)
    clearTimeout(syncTimer)
  })

  function applyProposal (source: AITaskProposalMessage): void {
    proposal = source
    accept()
  }

  function accept (): void {
    if (proposal === undefined) return
    // A proposal carries only what the model changed: everything it left out keeps its value,
    // otherwise editing the description alone would wipe the title.
    apply({
      title: proposal.title.trim() !== '' ? proposal.title : title,
      description: proposal.description !== undefined ? asMarkup(proposal.description) : asMarkup(description),
      // Same rule as title/description: the draft tool never proposes sub-tasks (it always posts an
      // empty list), so anything but a non-empty list keeps what the user typed in the form.
      subIssues:
        proposal.subtasks !== undefined && proposal.subtasks.length > 0
          ? proposal.subtasks.map((s) => s.title)
          : subIssues,
      priority: proposal.priority,
      estimation: proposal.estimation,
      dueDate: proposal.dueDate,
      labels: proposal.labels
    })
    applied = new Set([...applied, proposal._id as Ref<Doc>])
  }

  // The wide layout belongs to the card+panel row, which lives in another component: the class
  // goes on the shared wrapper and is removed as soon as the panel closes.
  function claimWideLayout (node: HTMLElement) {
    const wrap = node.closest('.antiCard-wrap')
    wrap?.classList.add('wide')
    return {
      destroy () {
        wrap?.classList.remove('wide')
      }
    }
  }
</script>

<!-- Never on mobile: the create dialog plus a conversation leaves no usable space on a phone. -->
{#if $issueAssistOpened && objectId !== undefined && $issueAssistFits}
  <!-- The slot holds the width in the row; the panel itself is absolute, so a long conversation
       scrolls instead of stretching the dialog beside it. -->
  <div class="assist-slot" use:claimWideLayout>
    <div class="assist">
      <div class="head">
        <span class="title">
          {#if bot !== undefined}
            <Avatar person={bot} size={'small'} name={bot.name} />
            <span class="name">{formatName(bot.name)}</span>
          {:else}
            <Label label={aiBot.string.AssistIssue} params={{ name: $aiBotNameStore }} />
          {/if}
        </span>
        <!-- No close button here: the header toggle next to the dialog's own cross owns that. -->
        <div class="actions">
          <Button
            icon={IconAdd}
            iconProps={{ size: 'small' }}
            label={aiBot.string.AssistIssueNewContext}
            kind={'ghost'}
            size={'small'}
            disabled={conversation === undefined || rootReplies === 0}
            on:click={resetConversation}
          />
        </div>
      </div>

      {#if conversation !== undefined}
        <!-- The regular thread view: feed, input, attachments, voice notes and read state all
             come from chat, instead of a second implementation living here. -->
        <div class="thread">
          <Component
            is={chunter.component.ThreadView}
            props={{
              _id: conversation.messageId,
              showHeader: false,
              syncLocation: false,
              autofocus: false
            }}
          />
        </div>
      {/if}
    </div>
  </div>
{/if}

<style lang="scss">
  // Width comes from the row when the wide layout applies; the minimum keeps the panel usable
  // if it ever renders next to a card that does not take part in it.
  .assist-slot {
    position: relative;
    align-self: stretch;
    width: 100%;
    min-width: 24rem;
    flex-shrink: 0;
  }

  // The panel floats beside the dialog, over the page, so it carries the popup's own background.
  // Absolute inside the slot: its height comes from the card, never from the conversation.
  .assist {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    min-height: 0;
    background: var(--theme-popup-color);
    border-radius: 0.5rem;
    box-shadow: var(--theme-popup-shadow);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 500;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .thread {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    min-height: 0;
  }
</style>
