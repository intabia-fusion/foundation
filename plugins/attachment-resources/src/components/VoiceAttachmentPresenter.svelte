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
  import attachment, { type Attachment } from '@hcengineering/attachment'
  import { getCurrentAccount, type Markup, type WithLookup } from '@hcengineering/core'
  import { createQuery, getClient, MessageViewer } from '@hcengineering/presentation'
  import { EmptyMarkup, jsonToMarkup, markupToJSON } from '@hcengineering/text'
  import { markdownToMarkup, markupToMarkdown } from '@hcengineering/text-markdown'
  import { StyledTextEditor } from '@hcengineering/text-editor-resources'
  import { Button, ButtonIcon, IconClose, IconEdit, Label, Spinner } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import activity from '@hcengineering/activity'
  import VoicePlayer from './VoicePlayer.svelte'

  type VoiceAttachment = WithLookup<Attachment> & {
    state?: 'pending' | 'done' | 'failed'
    text?: string
    edited?: boolean
  }

  // Duck-typed voice-note: an audio Attachment carrying transcription state/text
  // (e.g. ai-bot's AudioTranscribe). Kept dependency-free of ai-bot.
  export let value: VoiceAttachment
  export let removable = false
  // Callback instead of an event: the ui Component wrapper does not forward a `remove` event.
  export let onRemove: (() => void) | undefined = undefined

  const client = getClient()
  const me = getCurrentAccount()
  let editing = false
  let editMarkup: Markup = EmptyMarkup

  // The Map-held value is a snapshot from creation time (state='pending'); watch the DB doc so the
  // status/text update live when the worker finishes transcription.
  const liveQuery = createQuery()
  let live: VoiceAttachment = value
  $: liveQuery.query(attachment.class.Attachment, { _id: value._id }, (res) => {
    if (res[0] !== undefined) live = res[0] as VoiceAttachment
  })

  $: state = live.state
  $: text = (live.text ?? '').trim()
  // Transcript is stored as markdown; render it as markup so formatting shows.
  $: markup = text !== '' ? jsonToMarkup(markdownToMarkup(text, { refUrl: 'ref://', imageUrl: '' })) : EmptyMarkup
  $: canEdit = state === 'done' && me.socialIds.includes(live.createdBy ?? live.modifiedBy)

  function startEdit (): void {
    editMarkup = markup
    editing = true
  }

  function cancelEdit (): void {
    editing = false
  }

  async function saveEdit (): Promise<void> {
    editing = false
    const md = markupToMarkdown(markupToJSON(editMarkup)).trim()
    if (md !== text) {
      await client.updateDoc(live._class, live.space, live._id, { text: md, edited: true } as any)
    }
  }
</script>

<div class="voice" class:editing>
  <div class="row">
    <div class="player"><VoicePlayer file={value.file} name={value.name} contentType={value.type} /></div>
    {#if removable}
      <ButtonIcon icon={IconClose} size="small" kind="tertiary" on:click={() => onRemove?.()} />
    {/if}
  </div>

  {#if state === 'pending'}
    <div class="status"><Spinner size="x-small" /> <Label label={attachment.string.Transcribing} /></div>
  {:else if state === 'failed'}
    <div class="status error-color"><Label label={attachment.string.TranscriptionFailed} /></div>
  {:else if editing}
    <div class="editor">
      <StyledTextEditor bind:content={editMarkup} showButtons={false} />
      <div class="flex-row-center gap-2 justify-end mt-2">
        <Button label={view.string.Cancel} on:click={cancelEdit} />
        <Button label={activity.string.Update} accent on:click={saveEdit} />
      </div>
    </div>
  {:else if text !== ''}
    <div class="transcript-row">
      <div class="transcript"><MessageViewer message={markup} /></div>
      {#if canEdit}
        <ButtonIcon icon={IconEdit} size="small" kind="tertiary" on:click={startEdit} />
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .voice {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 16rem;
    max-width: 28rem;
    padding: 0.5rem;
    border-radius: 0.5rem;
    background: var(--theme-refinput-color);
    border: 1px solid var(--theme-refinput-border);
  }
  .voice.editing {
    max-width: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .player {
    flex: 1;
    min-width: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .transcript-row {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .transcript {
    flex: 1;
    font-size: 0.8125rem;
    word-break: break-word;
  }
  .editor {
    display: flex;
    flex-direction: column;
  }
</style>
