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

import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import {
  closeLoveWindows,
  closeMeetingContexts,
  connectedMarker,
  joinFirstAvailableRoom,
  openLove
} from './meeting-helpers'
import { routeLiveKitThroughProxy, startLiveKitProxy, type LiveKitProxy } from './network-helpers'

/** LiveKit signal state as the client sees it, read straight off the SDK room. */
async function lkState (page: Page): Promise<string> {
  return await page.evaluate(() => (window as any).__lkState ?? 'unknown')
}

/** A livekit-client log format change would otherwise surface as an `expect.poll` timeout. */
async function assertLkTracking (page: Page): Promise<void> {
  const seen: string[] = await page.evaluate(() => (window as any).__lkStates ?? [])
  expect(seen, 'LiveKit connection state hook caught nothing - check the SDK log format').not.toHaveLength(0)
}

/** Mirror the SDK connection state onto `window` so the test can poll it. */
async function trackLkState (page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any
    w.__lkState = 'unknown'
    w.__lkStates = []
    const orig = console.info.bind(console)
    console.info = (...args: any[]) => {
      const first = args[0]
      if (typeof first === 'string' && first.startsWith('connection state changed:')) {
        const to = first.replace('connection state changed:', '').split('->')[1]?.trim()
        if (to !== undefined) {
          w.__lkState = to
          w.__lkStates.push(to)
        }
      }
      orig(...args)
    }
  })
}

// Emulation is per CDP session, so a second session cannot lift the first one's offline flag.
const cdpSessions = new WeakMap<Page, CDPSession>()

// Whole-page network kill via CDP: unlike the proxy this also drops the platform WebSocket,
// so it models "the user lost their connection", not "only the LiveKit link went bad".
async function setOffline (ctx: BrowserContext, page: Page, offline: boolean): Promise<void> {
  let cdp = cdpSessions.get(page)
  if (cdp === undefined) {
    cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    cdpSessions.set(page, cdp)
  }
  await cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  })
}

// Own contexts, not the shared windows: `routeLiveKitThroughProxy` rewrites LIVEKIT_WS in
// config.json and CDP puts the context offline. Both outlive the test on a reused window and
// would pin every later test to a proxy that is already closed.
export function registerNetworkTests (): void {
  test.describe('meeting minutes - degraded link to LiveKit', () => {
    // The shared windows hold a live session for the same accounts this test signs in as, and two
    // sessions per user break presence and departure checks. Drop them; the next shared test pays
    // one boot to get its window back.
    test.beforeAll(async () => {
      await closeLoveWindows()
    })

    let proxy: LiveKitProxy | undefined

    test.afterEach(async () => {
      await proxy?.close()
      proxy = undefined
    })

    test('joins through a 300ms signal link', async ({ browser }) => {
      test.setTimeout(120000)
      proxy = await startLiveKitProxy(300)
      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await routeLiveKitThroughProxy(page, proxy)
        await openLove(page)
        const joined = await joinFirstAvailableRoom(page, 60000)
        test.skip(!joined, 'No regular room available')

        // Still connected once the join settles - a slow signal must not be
        // mistaken for a dead session by the widget logic.
        await page.waitForTimeout(3000)
        expect(await connectedMarker(page).count()).toBeGreaterThan(0)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('survives a signal outage and reconnects', async ({ browser }) => {
      test.setTimeout(120000)
      proxy = await startLiveKitProxy()
      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await trackLkState(page)
        await routeLiveKitThroughProxy(page, proxy)
        await openLove(page)
        const joined = await joinFirstAvailableRoom(page)
        test.skip(!joined, 'No regular room available')
        await assertLkTracking(page)

        // Kill the signal link for a few seconds, then let it back up.
        proxy.cut()
        await expect.poll(async () => await lkState(page), { timeout: 30000 }).toMatch(/reconnect|disconnected/i)
        await page.waitForTimeout(2000)
        proxy.restore()

        // The SDK re-establishes the signal channel and the meeting UI stays.
        const trail = async (): Promise<string> =>
          ((await page.evaluate(() => (window as any).__lkStates ?? [])) as string[]).join(' -> ')
        try {
          await expect.poll(async () => await lkState(page), { timeout: 60000 }).toBe('connected')
        } catch (err) {
          throw new Error(`LiveKit never came back. State trail: ${await trail()}`)
        }
        expect(await connectedMarker(page).count()).toBeGreaterThan(0)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })

    test('a peer surviving an outage keeps their seat for the other participant', async ({ browser }) => {
      test.setTimeout(150000)
      proxy = await startLiveKitProxy()
      const ctxA = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const ctxB = await browser.newContext({ storageState: '.auth/storageThird.json' })
      const pageA = await ctxA.newPage()
      const pageB = await ctxB.newPage()
      try {
        // Only A goes through the proxy; B watches the room over a healthy link.
        await trackLkState(pageA)
        await routeLiveKitThroughProxy(pageA, proxy)
        await openLove(pageA)
        const joined = await joinFirstAvailableRoom(pageA)
        test.skip(!joined, 'No regular room available')
        await assertLkTracking(pageA)

        await openLove(pageB)
        const joinedB = await joinFirstAvailableRoom(pageB)
        test.skip(!joinedB, 'No regular room available for the second participant')

        proxy.cut()
        await expect.poll(async () => await lkState(pageA), { timeout: 30000 }).toMatch(/reconnect|disconnected/i)
        await pageA.waitForTimeout(2000)
        proxy.restore()
        await expect.poll(async () => await lkState(pageA), { timeout: 60000 }).toBe('connected')

        // B must still be in the meeting, and A must not have been dropped out
        // of the UI by the reconnect.
        expect(await connectedMarker(pageB).count()).toBeGreaterThan(0)
        expect(await connectedMarker(pageA).count()).toBeGreaterThan(0)
      } finally {
        await closeMeetingContexts([
          { ctx: ctxA, pages: [pageA] },
          { ctx: ctxB, pages: [pageB] }
        ])
      }
    })

    test('whole-page offline: platform and LiveKit come back together', async ({ browser }) => {
      test.setTimeout(150000)
      const ctx = await browser.newContext({ storageState: '.auth/storageSecond.json' })
      const page = await ctx.newPage()
      try {
        await trackLkState(page)
        await openLove(page)
        const joined = await joinFirstAvailableRoom(page)
        test.skip(!joined, 'No regular room available')
        await assertLkTracking(page)

        await setOffline(ctx, page, true)
        await expect.poll(async () => await lkState(page), { timeout: 40000 }).toMatch(/reconnect|disconnected/i)
        await page.waitForTimeout(2000)
        await setOffline(ctx, page, false)

        const trail = async (): Promise<string> =>
          ((await page.evaluate(() => (window as any).__lkStates ?? [])) as string[]).join(' -> ')
        try {
          await expect.poll(async () => await lkState(page), { timeout: 60000 }).toBe('connected')
        } catch (err) {
          throw new Error(`LiveKit never came back. State trail: ${await trail()}`)
        }
        expect(await connectedMarker(page).count()).toBeGreaterThan(0)
      } finally {
        await closeMeetingContexts([{ ctx, pages: [page] }])
      }
    })
  })
}
