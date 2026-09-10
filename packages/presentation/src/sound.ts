//
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
//

import { type Asset, getMetadata } from '@hcengineering/platform'

// Raw undecoded audio, survives AudioContext recreation (AudioBuffer does not).
const sounds = new Map<Asset, ArrayBuffer>()

// The AudioContext holds the OS audio session while open. On iOS an open context
// interrupts CarPlay / background music and competes with the meeting (LiveKit)
// context. So we create it on demand and close it once nothing is playing.
let context: AudioContext | undefined
let activePlaybacks = 0

function getContext (): AudioContext {
  if (context === undefined || context.state === 'closed') {
    context = new AudioContext()
  }
  return context
}

function releaseContext (): void {
  if (activePlaybacks > 0 || context === undefined) return
  const ctx = context
  context = undefined
  void ctx.close().catch(() => {})
}

async function loadSound (key: string): Promise<ArrayBuffer | undefined> {
  const asset = key as Asset
  const cached = sounds.get(asset)
  if (cached !== undefined) return cached
  try {
    const soundUrl = getMetadata(asset) as string
    const rawAudio = await fetch(soundUrl)
    const rawBuffer = await rawAudio.arrayBuffer()
    sounds.set(asset, rawBuffer)
    return rawBuffer
  } catch (err) {
    console.error('Sound not found', key)
    return undefined
  }
}

export async function prepareSound (key: string): Promise<void> {
  await loadSound(key)
}

export async function playSound (soundKey: string, loop = false): Promise<(() => void) | null> {
  const raw = await loadSound(soundKey)
  if (raw === undefined) {
    console.error('Cannot prepare audio buffer', soundKey)
    return null
  }

  // Reserve before the async decode so a fast follow-up sound doesn't see
  // activePlaybacks==0 and let releaseContext() close the context mid-play.
  activePlaybacks++
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    activePlaybacks = Math.max(0, activePlaybacks - 1)
    releaseContext()
  }

  try {
    const ctx = getContext()
    // decodeAudioData detaches the ArrayBuffer, decode a copy so the cache stays reusable.
    const buffer = await ctx.decodeAudioData(raw.slice(0))
    const audio = ctx.createBufferSource()
    audio.buffer = buffer
    audio.loop = loop
    audio.connect(ctx.destination)

    // Natural end: only clean up. Manual stop: detach onended first so stop()
    // isn't re-entered by the resulting ended event.
    audio.onended = stop
    const stopAudio = (): void => {
      audio.onended = null
      try {
        audio.stop()
        audio.disconnect()
      } catch {}
      stop()
    }
    audio.start()

    return stopAudio
  } catch (err) {
    console.error('Error when playing sound back', soundKey, err)
    stop()
    return null
  }
}

// Throttle for high-frequency sounds (e.g. inbox pings) so bursts don't
// "chatter". At most one sound per window; extra requests within the window
// collapse into a single trailing sound, fired early once too many pile up.
const THROTTLE_WINDOW_MS = 15000
const THROTTLE_MAX_PENDING = 5
interface ThrottleState {
  lastPlayed: number
  pending: number
  timer: ReturnType<typeof setTimeout> | undefined
}
const throttleStates = new Map<string, ThrottleState>()

export function playThrottledSound (soundKey: string): void {
  const now = Date.now()
  let st = throttleStates.get(soundKey)
  if (st === undefined) {
    st = { lastPlayed: 0, pending: 0, timer: undefined }
    throttleStates.set(soundKey, st)
  }

  const elapsed = now - st.lastPlayed
  const fire = (): void => {
    st.lastPlayed = Date.now()
    st.pending = 0
    if (st.timer !== undefined) {
      clearTimeout(st.timer)
      st.timer = undefined
    }
    void playSound(soundKey)
  }

  if (elapsed >= THROTTLE_WINDOW_MS) {
    fire()
    return
  }

  st.pending++
  // Too many queued -> play now instead of waiting out the window.
  if (st.pending >= THROTTLE_MAX_PENDING) {
    fire()
    return
  }
  // Otherwise ensure a single trailing play at window end.
  st.timer ??= setTimeout(fire, THROTTLE_WINDOW_MS - elapsed)
}
