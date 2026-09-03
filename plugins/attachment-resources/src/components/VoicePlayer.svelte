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
  import type { Blob as PlatformBlob, Ref } from '@hcengineering/core'
  import { getFileUrl } from '@hcengineering/presentation'
  import { ButtonIcon } from '@hcengineering/ui'
  import Play from './icons/Play.svelte'
  import Pause from './icons/Pause.svelte'
  import FileDownload from './icons/FileDownload.svelte'
  import { onMount } from 'svelte'

  export let file: Ref<PlatformBlob>
  export let name: string
  export let contentType: string

  const NUM_BARS = 32
  let bars: number[] = new Array(NUM_BARS).fill(0.15)

  let audioEl: HTMLAudioElement
  let downloadEl: HTMLAnchorElement
  let paused = true
  let time = 0
  let duration = 0

  $: src = getFileUrl(file, name)
  $: progress = duration > 0 ? time / duration : 0
  $: mmss = fmt(time) + ' / ' + fmt(duration)

  function fmt (s: number): string {
    if (!Number.isFinite(s)) return '0:00'
    return `${Math.floor(s / 60)}:${`${Math.floor(s % 60)}`.padStart(2, '0')}`
  }

  function toggle (): void {
    if (audioEl === undefined) return
    if (paused) void audioEl.play()
    else audioEl.pause()
  }

  function seek (e: MouseEvent): void {
    if (duration <= 0) return
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    audioEl.currentTime = ((e.clientX - r.left) / r.width) * duration
  }

  onMount(async () => {
    try {
      const res = await fetch(src)
      const buf = await res.arrayBuffer()
      const ctx = new AudioContext()
      const audio = await ctx.decodeAudioData(buf)
      void ctx.close()
      // webm/opus <audio> duration is Infinity until a full seek; use the decoded buffer instead
      duration = audio.duration
      bars = rms(audio.getChannelData(0), NUM_BARS)
    } catch {
      // keep the flat placeholder bars on failure
    }
  })

  // Per-bar RMS of the waveform, normalized to [0.1..1].
  function rms (data: Float32Array, count: number): number[] {
    const seg = Math.floor(data.length / count)
    const out: number[] = []
    let max = 0
    for (let i = 0; i < count; i++) {
      let sum = 0
      for (let j = 0; j < seg; j++) {
        const v = data[i * seg + j]
        sum += v * v
      }
      const r = Math.sqrt(sum / seg)
      out.push(r)
      if (r > max) max = r
    }
    return out.map((r) => (max > 0 ? Math.max(0.1, r / max) : 0.15))
  }
</script>

<audio bind:this={audioEl} bind:paused bind:currentTime={time} {src} preload="metadata" />

<div class="player">
  <ButtonIcon icon={paused ? Play : Pause} size="small" kind="primary" on:click={toggle} />
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="wave" on:click={seek}>
    {#each bars as b, i}
      <div class="bar" class:played={i / NUM_BARS <= progress} style="height: {Math.max(2, b * 22)}px" />
    {/each}
  </div>
  <span class="timer">{mmss}</span>
  <a class="dl" bind:this={downloadEl} href={src} download={name} on:click|stopPropagation>
    <ButtonIcon
      icon={FileDownload}
      size="small"
      kind="tertiary"
      on:click={() => {
        downloadEl.click()
      }}
    />
  </a>
</div>

<style lang="scss">
  .player {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 4rem;
    height: 24px;
    cursor: pointer;
  }
  .bar {
    flex: 1;
    min-width: 2px;
    border-radius: 2px;
    background: var(--theme-halfcontent-color, #a0a0a0);
    &.played {
      background: var(--theme-primary-default, #4870ff);
    }
  }
  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
    color: var(--theme-dark-color);
    white-space: nowrap;
  }
  .dl {
    display: inline-flex;
    color: inherit;
  }
</style>
