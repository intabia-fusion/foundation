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

import { expect, test, type Page } from '@playwright/test'
import core from '@hcengineering/core'
import love, { type DevicesPreference } from '@hcengineering/love'
import {
  closeLoveWindows,
  closeMeetingContexts,
  getMeetingsUser,
  joinFirstAvailableRoom,
  openLove
} from './meeting-helpers'

interface MicRequest {
  deviceId: string | null
  exact: boolean
}

// Swaps Chrome's fake audio inputs for a known pair and records every microphone
// `getUserMedia`; the deviceId constraint is stripped so the real fake device still answers.
async function installMediaShim (page: Page, options: { mics: string[], storedMic?: string }): Promise<void> {
  await page.addInitScript((opts: { mics: string[], storedMic?: string }) => {
    if (opts.storedMic !== undefined) {
      localStorage.setItem('selectedDevice_mic', opts.storedMic)
    }
    const md = navigator.mediaDevices
    const realEnumerate = md.enumerateDevices.bind(md)
    const realGum = md.getUserMedia.bind(md)
    const requests: Array<{ deviceId: string | null, exact: boolean }> = []
    ;(window as any).__micRequests = requests

    md.enumerateDevices = async () => {
      const real = await realEnumerate()
      const fake = opts.mics.map(
        (id, i) => ({ kind: 'audioinput', deviceId: id, groupId: `group-${i}`, label: `Fake Mic ${id}` }) as any
      )
      return [...fake, ...real.filter((d) => d.kind !== 'audioinput')]
    }

    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const audio = constraints?.audio
      if (audio == null || audio === false) return await realGum(constraints)
      if (audio === true) {
        requests.push({ deviceId: null, exact: false })
        return await realGum(constraints)
      }
      const raw = (audio as any).deviceId
      const exact = typeof raw === 'object' && raw !== null && raw.exact !== undefined
      const deviceId: string | null =
        typeof raw === 'string' ? raw : ((raw?.exact ?? raw?.ideal ?? null) as string | null)
      requests.push({ deviceId, exact })
      const { deviceId: _dropped, ...rest } = audio as any
      return await realGum({ ...constraints, audio: rest })
    }
  }, options)
}

async function micRequests (page: Page): Promise<MicRequest[]> {
  return await page.evaluate(() => (window as any).__micRequests ?? [])
}

async function lastExactMic (page: Page): Promise<string | null> {
  const all = await micRequests(page)
  const exact = all.filter((r) => r.exact && r.deviceId != null)
  return exact.length > 0 ? (exact[exact.length - 1].deviceId as string) : null
}

/** Sets `micEnabled` for PlatformUserSecond; returns a restore callback. */
async function setStartMuted (muted: boolean): Promise<() => Promise<void>> {
  const { client, account } = await getMeetingsUser()
  const existing = await client.findAll<DevicesPreference>(love.class.DevicesPreference, { attachedTo: account })
  if (existing.length > 0) {
    const prev = existing[0].micEnabled
    await client.updateDoc(love.class.DevicesPreference, existing[0].space, existing[0]._id, { micEnabled: !muted })
    return async () => {
      await client.updateDoc(love.class.DevicesPreference, existing[0].space, existing[0]._id, { micEnabled: prev })
    }
  }
  const id = await client.createDoc<DevicesPreference>(love.class.DevicesPreference, core.space.Workspace, {
    attachedTo: account,
    noiseCancellation: true,
    micEnabled: !muted,
    camEnabled: false,
    blurRadius: 0
  })
  return async () => {
    await client.removeDoc(love.class.DevicesPreference, core.space.Workspace, id)
  }
}

// Own contexts, not the shared windows: `installMediaShim` is an addInitScript that replaces
// enumerateDevices, and it cannot be removed from a window later tests keep using.
export function registerDeviceTests (): void {
  test.describe('meeting minutes - audio device selection', () => {
    // The shared windows hold a live session for the same accounts this test signs in as, and two
    // sessions per user break presence and departure checks. Drop them; the next shared test pays
    // one boot to get its window back.
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    test('muted join still publishes the stored microphone on unmute', async ({ browser }) => {
      test.setTimeout(90000)
      const restore = await setStartMuted(true)
      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await installMediaShim(page, { mics: ['mic-a', 'mic-b'], storedMic: 'mic-b' })
        await openLove(page)
        const joined = await joinFirstAvailableRoom(page)
        test.skip(!joined, 'No regular room available')

        const micButton = page.locator('[data-id="mic-button"]').first()
        await expect(micButton).toHaveAttribute('data-enabled', 'false', { timeout: 15000 })
        await micButton.locator('button').first().click()
        await expect(micButton).toHaveAttribute('data-enabled', 'true', { timeout: 15000 })

        // Before the fix the muted session carried no deviceId, so LiveKit
        // published with the browser default and never asked for mic-b.
        await expect.poll(async () => await lastExactMic(page), { timeout: 15000 }).toBe('mic-b')
      } finally {
        await restore()
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('stored microphone survives the device being unplugged', async ({ browser }) => {
      test.setTimeout(90000)
      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await installMediaShim(page, { mics: ['mic-a', 'mic-b'], storedMic: 'mic-unplugged' })
        await openLove(page)
        const joined = await joinFirstAvailableRoom(page)
        test.skip(!joined, 'No regular room available')

        // The session falls back to a device that exists...
        await expect.poll(async () => await lastExactMic(page), { timeout: 15000 }).toBe('mic-a')
        // ...but the user's choice stays in localStorage so it comes back with the device.
        expect(await page.evaluate(() => localStorage.getItem('selectedDevice_mic'))).toBe('mic-unplugged')
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })
  })
}
