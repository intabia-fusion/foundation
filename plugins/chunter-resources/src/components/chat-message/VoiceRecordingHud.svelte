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
  import aiBot, { AudioTranscribe } from '@hcengineering/ai-bot'
  import { Class, Doc, generateId, getCurrentAccount, Ref, Space } from '@hcengineering/core'
  import { getClient, uploadFile } from '@hcengineering/presentation'
  import { getCurrentEmployeeName } from '@hcengineering/contact-resources'
  import { ButtonIcon, IconClose, IconCheck, IconSend, Label, Spinner } from '@hcengineering/ui'
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'
  import slugify from 'slugify'

  import chunter from '../../plugin'
  import { VoiceRecorder } from '../../voiceRecorder'

  // Draft message this recording attaches to (objectId = future message id).
  export let objectId: Ref<Doc>
  export let objectClass: Ref<Class<Doc>>
  export let space: Ref<Space>

  const client = getClient()
  const dispatch = createEventDispatcher()

  const recorder = new VoiceRecorder()

  type Phase = 'starting' | 'recording' | 'saving'
  // 'starting' while getUserMedia/permission resolves, so the user waits for the go-ahead instead
  // of talking into a mic that isn't capturing yet (losing the first words).
  let phase: Phase = 'starting'
  let elapsed = 0
  let timer: any
  let raf: number | undefined

  const NUM_BARS = 16
  let bars: number[] = new Array(NUM_BARS).fill(0)
  let destroyed = false

  onMount(() => {
    void begin()
  })

  async function begin (): Promise<void> {
    try {
      await recorder.start()
    } catch {
      dispatch('close')
      return
    }
    // getUserMedia may resolve after the HUD is gone; release the mic instead of leaking it.
    if (destroyed) {
      recorder.cancel()
      return
    }
    phase = 'recording'
    timer = setInterval(() => {
      elapsed += 1
    }, 1000)
    const tick = (): void => {
      bars = [...bars.slice(1), recorder.getLevel()]
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  function stopTimers (): void {
    if (timer !== undefined) clearInterval(timer)
    if (raf !== undefined) cancelAnimationFrame(raf)
    timer = undefined
    raf = undefined
  }

  // Stop the mic, upload the blob and create the AudioTranscribe doc. Returns undefined on failure.
  async function persist (): Promise<AudioTranscribe | undefined> {
    stopTimers()
    let rec
    try {
      rec = await recorder.stop()
    } catch {
      dispatch('close')
      return undefined
    }
    phase = 'saving'
    const id = generateId<AudioTranscribe>()
    const ext = rec.type.includes('ogg') ? 'ogg' : 'webm'
    const author = slugify(await getCurrentEmployeeName(), { lower: false }) || 'voice'
    const name = `${author}-${Date.now()}.${ext}`
    const file = new File([rec.blob], name, { type: rec.type })
    const { uuid, metadata } = await uploadFile(file)
    const data = {
      name,
      file: uuid,
      type: rec.type,
      size: file.size,
      lastModified: Date.now(),
      metadata,
      state: 'pending' as const,
      durationSec: Math.round(rec.durationSec)
    }
    await client.addCollection<Doc, AudioTranscribe>(
      aiBot.class.AudioTranscribe,
      space,
      objectId,
      objectClass,
      'attachments',
      data,
      id
    )
    const doc = {
      _id: id,
      _class: aiBot.class.AudioTranscribe,
      space,
      attachedTo: objectId,
      attachedToClass: objectClass,
      collection: 'attachments',
      modifiedOn: Date.now(),
      modifiedBy: getCurrentAccount().primarySocialId,
      ...data
    } as unknown as AudioTranscribe
    // Attach right away (shows as 'transcribing…' in the input) instead of blocking on the worker.
    dispatch('audio', doc)
    return doc
  }

  async function onAttach (): Promise<void> {
    const doc = await persist()
    if (doc !== undefined) dispatch('close')
  }

  async function onSend (): Promise<void> {
    const doc = await persist()
    if (doc === undefined) return
    // Submit right away; the transcript keeps filling in live on the already-sent attachment
    // (presenter watches the doc), so there is no need to block the send on the worker.
    dispatch('send')
    dispatch('close')
  }

  function onCancel (): void {
    stopTimers()
    recorder.cancel()
    dispatch('close')
  }

  onDestroy(() => {
    destroyed = true
    stopTimers()
    // Release the mic on any teardown path so the browser tab drops the recording indicator.
    recorder.cancel()
  })

  $: mmss = `${Math.floor(elapsed / 60)}`.padStart(2, '0') + ':' + `${elapsed % 60}`.padStart(2, '0')
</script>

<div class="hud">
  {#if phase === 'starting'}
    <Spinner size="small" />
    <span class="timer"><Label label={chunter.string.PreparingMic} /></span>
    <ButtonIcon
      icon={IconClose}
      size="small"
      kind="tertiary"
      tooltip={{ label: chunter.string.VoiceCancel }}
      on:click={onCancel}
    />
  {:else if phase === 'recording'}
    <div class="dot" />
    <span class="timer">{mmss}</span>
    <div class="wave">
      {#each bars as b}
        <div class="bar" style="height: {Math.max(2, b * 22)}px" />
      {/each}
    </div>
    <ButtonIcon
      icon={IconClose}
      size="small"
      kind="tertiary"
      tooltip={{ label: chunter.string.VoiceCancel }}
      on:click={onCancel}
    />
    <ButtonIcon
      icon={IconCheck}
      size="small"
      kind="secondary"
      tooltip={{ label: chunter.string.VoiceAttach }}
      on:click={onAttach}
    />
    <ButtonIcon
      icon={IconSend}
      size="small"
      kind="primary"
      tooltip={{ label: chunter.string.VoiceSend }}
      on:click={onSend}
    />
  {:else}
    <!-- Upload only: the message is sent without waiting for the transcript. -->
    <Spinner size="small" />
  {/if}
</div>

<style lang="scss">
  .hud {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    width: fit-content;
    margin-bottom: 0.75rem;
    padding: 0.375rem 0.625rem;
    border-radius: 0.5rem;
    background: var(--theme-refinput-color);
    border: 1px solid var(--theme-refinput-border);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--theme-error-color, #e05252);
    animation: pulse 1s infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  .timer {
    font-variant-numeric: tabular-nums;
    min-width: 3rem;
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 5rem;
    height: 24px;
    overflow: hidden;
  }
  .bar {
    width: 3px;
    border-radius: 2px;
    background: var(--theme-primary-default, #4870ff);
    transition: height 0.08s linear;
  }
</style>
