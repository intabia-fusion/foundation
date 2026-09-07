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

import { createRestClient, getWorkspaceToken, loadServerConfig, type RestClient } from '@hcengineering/api-client'
import { type AccountUuid, type Ref, systemAccountUuid } from '@hcengineering/core'
import love, {
  MeetingStatus,
  type MeetingMinutes,
  type ParticipantInfo,
  type UserMeetingInvite
} from '@hcengineering/love'
import { generateToken } from '@hcengineering/server-token'
import { PlatformURI, PlatformUserSecond } from '../utils'
import { retry, retryIntervals } from '../retry'
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { OfficePage } from '../model/love/office-page'
import { RoomServiceClient } from 'livekit-server-sdk'

const MEETINGS_WS = 'meetings-ws'

let cachedRestClient: RestClient | undefined
let cachedAccount: AccountUuid | undefined
let cachedSystemRestClient: RestClient | undefined

async function getMeetingsRestClient (): Promise<RestClient> {
  return (await getMeetingsUser()).client
}

/** REST client for PlatformUserSecond plus that account's uuid (needed to write per-account docs). */
export async function getMeetingsUser (): Promise<{ client: RestClient, account: AccountUuid }> {
  if (cachedRestClient !== undefined && cachedAccount !== undefined) {
    return { client: cachedRestClient, account: cachedAccount }
  }
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: MEETINGS_WS },
    config
  )
  cachedRestClient = createRestClient(token.endpoint, token.workspaceId, token.token)
  cachedAccount = token.info.account
  return { client: cachedRestClient, account: cachedAccount }
}

/** Raw workspace JWT for PlatformUserSecond - the same Bearer the browser sends to `/_love/*`. */
export async function getPlatformToken (): Promise<string> {
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: MEETINGS_WS },
    config
  )
  return token.token
}

export function loveEndpoint (): string {
  return `${(PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')}/_love`
}

export async function getSystemRestClient (): Promise<RestClient> {
  if (cachedSystemRestClient !== undefined) return cachedSystemRestClient
  const baseUrl = (PlatformURI ?? 'http://localhost:8083').replace(/\/$/, '')
  const config = await loadServerConfig(baseUrl)
  const token = await getWorkspaceToken(
    baseUrl,
    { email: PlatformUserSecond, password: '1234', workspace: MEETINGS_WS },
    config
  )
  const systemToken = generateToken(systemAccountUuid, token.workspaceId, undefined, 'secret')
  cachedSystemRestClient = createRestClient(token.endpoint, token.workspaceId, systemToken)
  return cachedSystemRestClient
}

/** Drains leftover invites past their 30s TTL. Needs a system token: invites live in
 *  per-user PersonSpaces, where only the owner or system may removeDoc. */
async function drainPendingInvites (): Promise<void> {
  try {
    const sys = await getSystemRestClient()
    const all = await sys.findAll<UserMeetingInvite>(love.class.UserMeetingInvite, {})
    await Promise.all(
      all.map((it) => sys.removeDoc(love.class.UserMeetingInvite, it.space, it._id).catch(() => undefined))
    )
  } catch {
    // Best-effort; if system token isn't configured the polling loop below
    // still drains via TTL (just slower).
  }
}

// The stand's LiveKit serves this suite alone, so its rooms are always ours to close or inspect.
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL ?? 'http://localhost:7890'
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'testkey'
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'testsecret_for_sanity_tests_min32chars'

let cachedRoomClient: RoomServiceClient | undefined

/**
 * Deletes the LiveKit rooms themselves - the same call the love poller makes, just now. Without it
 * a participant whose office owner left keeps a live session until `OWNER_REJOIN_GRACE_SEC`
 * expires, and every test that ends that way pays the grace.
 *
 * Kills live sessions, so it belongs in teardown or in a test that means to end the meeting - never
 * in a `beforeEach`, where it drops the previous test's windows mid-setup.
 */
export async function closeLiveKitRooms (): Promise<boolean> {
  try {
    cachedRoomClient ??= new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    const rooms = await cachedRoomClient.listRooms()
    await Promise.all(rooms.map((r) => cachedRoomClient?.deleteRoom(r.name).catch(() => undefined)))
    return rooms.length > 0
  } catch {
    // Best-effort: LiveKit unreachable only means the poller closes them on its own schedule.
    return false
  }
}

/** The LiveKit room backing a meeting, named `<workspace>_<meetingId>` by the love service. */
export async function liveKitRoomOf (meetingId: Ref<MeetingMinutes>): Promise<string | null> {
  cachedRoomClient ??= new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  const rooms = await cachedRoomClient.listRooms()
  return rooms.find((r) => r.name.endsWith(`_${meetingId}`))?.name ?? null
}

/** Force-finishes every non-Finished meeting through the transactor: the `room_finished`
 *  webhook is not the path tests care about, and a leftover Scheduled one hijacks Connect. */
async function forceFinishAllMeetings (): Promise<number> {
  try {
    const sys = await getSystemRestClient()
    const [meetings, participants] = await Promise.all([
      sys.findAll<MeetingMinutes>(love.class.MeetingMinutes, {
        status: { $in: [MeetingStatus.Active, MeetingStatus.Pending, MeetingStatus.Scheduled] }
      }),
      sys.findAll<ParticipantInfo>(love.class.ParticipantInfo, {})
    ])
    await Promise.all([
      ...meetings.map((m) =>
        sys
          .updateDoc(love.class.MeetingMinutes, m.space, m._id, {
            status: MeetingStatus.Finished,
            meetingEnd: Date.now()
          })
          .catch(() => undefined)
      ),
      ...participants.map((p) => sys.removeDoc(love.class.ParticipantInfo, p.space, p._id).catch(() => undefined))
    ])
    return meetings.length + participants.length
  } catch {
    // Best-effort; polling loop below covers the slow path.
    return 0
  }
}

/**
 * Waits until no meeting is Active or Pending: a leftover one carries its owners and members into
 * the next test and breaks owner-only and locked-room checks. Returns whether anything had to be
 * finished - a client watching such a meeting navigates to its MeetingMinutes shortly after.
 */
export async function waitForActiveMeetingsToFinish (timeoutMs = 20000): Promise<boolean> {
  const client = await getMeetingsRestClient()
  const [finished] = await Promise.all([forceFinishAllMeetings(), drainPendingInvites()])
  const deadline = Date.now() + timeoutMs
  let left = 'nothing'
  while (Date.now() < deadline) {
    const [meetings, participants, invites] = await Promise.all([
      client.findAll<MeetingMinutes>(
        love.class.MeetingMinutes,
        { status: { $in: [MeetingStatus.Active, MeetingStatus.Pending, MeetingStatus.Scheduled] } },
        { limit: 1 }
      ),
      // A leftover row makes the office owner look "in a meeting" on the next test's floor
      // grid and fools the server's knock detection.
      client.findAll<ParticipantInfo>(love.class.ParticipantInfo, {}, { limit: 1 }),
      // Stale invites from a previous test trip up `toHaveCount`/`toBeHidden` in the next
      // one.
      client.findAll<UserMeetingInvite>(love.class.UserMeetingInvite, {}, { limit: 1 })
    ])
    if (meetings.length === 0 && participants.length === 0 && invites.length === 0) return finished > 0
    left = `meetings=${meetings.length} participants=${participants.length} invites=${invites.length}`
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  // Falling out of the loop leaves the next test on dirty state - it then fails seconds later on
  // some unrelated locator with nothing pointing back here.
  console.warn(`[love] cleanup did not settle in ${timeoutMs}ms, still there: ${left}`)
  return true
}

// `sendKnockRequest` returns silently until the employee and their space resolve, so an early
// click creates nothing. Re-clicking is safe: the apply carries `notMatch` on a pending request.
export async function knockAndWaitPending (page: Page, timeoutMs = 30000): Promise<void> {
  const knockBtn = page.locator('[data-id="meeting-knock"]').first()
  const pending = page.locator('[data-id="meeting-knock-pending"]').first()
  await expect(async () => {
    if (await pending.isVisible()) return
    await knockBtn.click({ timeout: 5000 })
    await expect(pending).toBeVisible({ timeout: 5000 })
  }).toPass({ intervals: retryIntervals, timeout: timeoutMs })
}

/** Closes pages and contexts in `finally`. A half-closed LiveKit session causes DTLS
 *  handshake timeouts on the next connect. Windows from `loveWindow` are shared by the whole
 *  suite: those are rolled back instead of closed. */
export async function closeMeetingContexts (entries: Array<{ ctx: BrowserContext, pages: Page[] }>): Promise<void> {
  const sharedCtx = new Set<BrowserContext>()
  const sharedPage = new Set<Page>()
  for (const w of loveWindows.values()) {
    sharedCtx.add(w.ctx)
    sharedPage.add(w.page)
  }
  // In parallel: the sequential loop cost 200-400ms per context, and the webhook that
  // `Page.close` triggers fires asynchronously anyway.
  const allPages = entries.flatMap((e) => e.pages).filter((p) => !sharedPage.has(p))
  await Promise.all(allPages.map((p) => p.close().catch(() => undefined)))
  await Promise.all(
    entries
      .map(({ ctx }) => ctx)
      .filter((ctx) => !sharedCtx.has(ctx))
      .map((ctx) => ctx.close().catch(() => undefined))
  )
  // Wait for `room_finished` and its ParticipantInfo cleanup, or the next test sees the
  // owner as "still in a meeting" and the floor grid misses their office.
  await resetLoveWindows()
}

export const ROOM_CANDIDATES = ['Meeting Room 1', 'Meeting Room 2', 'All hands', 'Voice only room']

/** Either surface proves the LiveKit session is live: the sidebar widget is not
 *  rendered when the meeting opens in the main area. */
export function connectedMarker (page: Page): Locator {
  return page
    .locator('[data-id="meeting-widget"], [data-id="control-bar"][data-connected="true"]')
    .locator('visible=true')
}

/** Grid cells of a room that currently render a participant avatar. */
export async function occupiedCells (page: Page, roomName: string): Promise<number> {
  return await page.locator(`[data-id="room-${roomName}"] .floorGrid-room__field:has(.hulyAvatar-container)`).count()
}

export async function openLove (page: Page): Promise<OfficePage> {
  const office = new OfficePage(page)
  await (await page.goto(`${PlatformURI}/workbench/${MEETINGS_WS}/love`))?.finished()
  await expect(office.floorGrid()).toBeVisible({ timeout: 15000 })
  return office
}

export type LoveUser = 'first' | 'second' | 'third'

const LOVE_STORAGE: Record<LoveUser, string> = {
  first: '.auth/storage.json',
  second: '.auth/storageSecond.json',
  third: '.auth/storageThird.json'
}

export interface LoveWindow {
  ctx: BrowserContext
  page: Page
}

const loveWindows = new Map<LoveUser, LoveWindow>()

/**
 * One window per user, kept for the whole suite and already sitting on the floor. A fresh context
 * costs a full SPA boot - 129ms of navigation plus 845ms until the floor grid paints - and the
 * suite opened 92 of them, a quarter of its wall time. The love project runs sequentially, so a
 * shared window is safe; `closeMeetingContexts` rolls it back instead of closing it.
 */
export async function loveWindow (browser: Browser, user: LoveUser): Promise<LoveWindow> {
  const existing = loveWindows.get(user)
  if (existing !== undefined && !existing.page.isClosed()) {
    await ensureOffice(existing.page)
    return existing
  }
  const ctx = await browser.newContext({ storageState: LOVE_STORAGE[user] })
  const page = await ctx.newPage()
  const win = { ctx, page }
  loveWindows.set(user, win)
  await openLove(page)
  return win
}

/** Back to the floor. Already there means the app is booted, which is the whole point. */
async function ensureOffice (page: Page): Promise<void> {
  if (onOffice(page)) {
    await expect(new OfficePage(page).floorGrid()).toBeVisible({ timeout: 15000 })
    return
  }
  await openLove(page)
}

/** A modal a test left open covers the leave button, and the click is then swallowed. */
async function dismissPopups (page: Page): Promise<void> {
  const open = page.locator('.hulyModal-container, .antiPopup, .modal-overlay').locator('visible=true')
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await open.count().catch(() => 0)) === 0) return
    await page.keyboard.press('Escape').catch(() => undefined)
  }
}

/**
 * Leaves whatever meeting the window is in. Closing the context used to do this implicitly; a
 * live LiveKit session left behind is force-finished by the server instead, and the client then
 * navigates to the MeetingMinutes page in the middle of the next test.
 * Returns whether there was one - only such a window can be navigated away later.
 */
async function leaveMeeting (page: Page): Promise<boolean> {
  if (page.isClosed()) return false
  await dismissPopups(page)
  const leave = page.locator('[data-id="meeting-leave"]').first()
  if (!(await leave.isVisible().catch(() => false))) return false
  try {
    // Retried as a whole: a popup can reopen between the dismiss and the click.
    await expect(async () => {
      if ((await connectedMarker(page).count()) === 0) return
      await dismissPopups(page)
      await leave.click({ timeout: 5000 })
      expect(await connectedMarker(page).count()).toBe(0)
    }).toPass({ intervals: retryIntervals, timeout: 20000 })
  } catch {
    // The server-side cleanup is the backstop.
  }
  return true
}

function onOffice (page: Page): boolean {
  return /\/love(\?|#|$|\/)/.test(page.url())
}

/**
 * Puts the window back on the floor and keeps it there. Finishing a meeting makes its client
 * navigate to the MeetingMinutes page, and that navigation lands after the server call returns -
 * restoring the floor once is not enough, the next test then clicks a room that is not on screen.
 */
async function settleOnOffice (page: Page, mayNavigate: boolean): Promise<void> {
  if (page.isClosed()) return
  await dismissPopups(page)
  if (!mayNavigate) {
    await ensureOffice(page).catch(() => undefined)
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureOffice(page).catch(() => undefined)
    // The client reacts to the finish over its websocket, so the navigation lands in tens of ms;
    // this is paid on every window of every test, so it stays as short as it can be.
    await page.waitForTimeout(150)
    if (onOffice(page)) return
  }
  await ensureOffice(page).catch(() => undefined)
}

/** Per-test teardown: leave meetings, drain the server, then restore the floor - in that order. */
export async function resetLoveWindows (): Promise<void> {
  const left = new Map<Page, boolean>()
  for (const { page } of loveWindows.values()) {
    left.set(page, await leaveMeeting(page))
  }
  // The client keeps a `love.activeMeeting` anchor in sessionStorage and reconnects to it on the
  // next store tick - and `connectToMeeting` navigates to the meeting's minutes page on the way, so
  // a window carrying a stale anchor leaves the floor in the middle of the following test.
  for (const { page } of loveWindows.values()) {
    await page
      .evaluate(() => {
        sessionStorage.removeItem('love.activeMeeting')
      })
      .catch(() => undefined)
  }
  // After the windows have left, so nothing is dropped mid-test, and before the settle loop below,
  // which is what absorbs the navigation a killed session triggers.
  const closed = await closeLiveKitRooms()
  // A test that left through the UI still leaves the meeting doc behind, and finishing it here is
  // what makes its client navigate away - so the late navigation follows the server change, not
  // the UI leave, and every window has to be watched when the cleanup changed anything.
  const finished = await waitForActiveMeetingsToFinish()
  for (const { page } of loveWindows.values()) {
    await settleOnOffice(page, finished || closed || (left.get(page) ?? false))
  }
}

/** Suite teardown. */
export async function closeLoveWindows (): Promise<void> {
  const entries = [...loveWindows.values()]
  loveWindows.clear()
  await Promise.all(entries.map(({ page }) => page.close().catch(() => undefined)))
  await Promise.all(entries.map(({ ctx }) => ctx.close().catch(() => undefined)))
}

/** Either surface counts as connected, so this also covers a meeting opened in the main area. */
export async function waitConnected (page: Page, timeout = 60000): Promise<void> {
  await expect.poll(async () => await connectedMarker(page).count(), { timeout }).toBeGreaterThan(0)
}

/**
 * Connect on the floor's room panel. The MeetingMinutes page renders a `meeting-connect` of its own,
 * and for a finished meeting that one connects to nothing - an unscoped locator picks whichever is
 * in the DOM and the test then waits out its timeout on a dead button.
 */
export function roomPanelConnect (page: Page): Locator {
  return page.locator('[data-id="room-panel"] [data-id="meeting-connect"]').getByRole('button').first()
}

export async function startOrJoin (page: Page, timeout = 30000): Promise<void> {
  const connect = roomPanelConnect(page)
  await expect(connect).toBeVisible({ timeout })
  // Capped: a panel over the room card leaves the button visible but unclickable, and an
  // uncapped click waits out the whole test.
  await connect.click({ timeout: 10000 })
}

/**
 * Opens the minutes of the room's live meeting. The floor lists one link per meeting the room ever
 * had - 41 of them on a stand that has run the suite a few times - and every one of them carries
 * the same text, so picking by position opened some meeting from an earlier run: the test then
 * toggled privacy on a finished meeting and the real one stayed public.
 * Falls back to picking by position when no meeting is live.
 */
export async function openMeetingMinutes (page: Page, roomName: string, pick: 'first' | 'last' = 'last'): Promise<void> {
  const meeting = await waitRoomMeeting(roomName, 5000).catch(() => undefined)
  const links =
    meeting !== undefined
      ? page.locator(`a[href*="${meeting._id}"]`)
      : page.getByRole('link', { name: new RegExp(`${roomName}.*20\\d{2}`) })
  const link = pick === 'first' ? links.first() : links.last()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click()
}

export async function clickOfficeOf (page: Page, lastName: string): Promise<Locator> {
  await backToFloorIfLost(page)
  const office = page
    .locator('div.floorGrid-room')
    .filter({ hasText: new RegExp(lastName, 'i') })
    .first()
  await expect(office).toBeVisible({ timeout: 15000 })
  await office.click()
  return office
}

/**
 * Retried as a whole: the MeetingMinutes page of a meeting that just finished elsewhere carries its
 * own Connect button, so a navigation landing between the room click and the click on Connect ends
 * up pressing a button that can never connect - and the wait below then burns its whole timeout.
 */
export async function joinRoom (page: Page, name: string, timeout = 45000): Promise<void> {
  await retry(async () => {
    await clickRoomByName(page, name)
    const connect = roomPanelConnect(page)
    // `showConnectionButton` hides Connect while we are in that very room (EditRoom.svelte), so an
    // already-joined window has nothing to click and waiting for the button burns the whole budget.
    if (!(await connect.isVisible().catch(() => false)) && (await connectedMarker(page).count()) > 0) return
    // Knock in place of Connect means the room holds a meeting we are not part of. Retrying cannot
    // help, and without this the caller reports a missing button 45s later.
    if ((await page.locator('[data-id="meeting-knock"], [data-id="meeting-knock-pending"]').count()) > 0) {
      throw new Error(`room "${name}" is locked by someone else's meeting - Knock is shown, not Connect`)
    }
    await expect(connect).toBeVisible({ timeout: 10000 })
    await connect.click({ timeout: 10000 })
    await expect.poll(async () => await connectedMarker(page).count(), { timeout: 10000 }).toBeGreaterThan(0)
  }, timeout)
}

/** Waits for each candidate: `count()` does not, and under load the grid paints before its
 *  rooms, so a run silently lands on a different room than the one before. */
export async function firstAvailableRoom (page: Page, exclude: string[] = []): Promise<string | null> {
  await backToFloorIfLost(page)
  const present: string[] = []
  for (const name of ROOM_CANDIDATES) {
    if (exclude.includes(name)) continue
    const rendered = await page
      .locator(`[data-id="room-${name}"]`)
      .first()
      .waitFor({ state: 'attached', timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    if (!rendered) continue
    // Occupied means locked: someone else's meeting renders Knock where Connect would be, and the
    // caller then waits out its whole budget on a button that never appears. A participant row the
    // previous test failed to drain is enough - always the first candidate, always the same room.
    if ((await occupiedCells(page, name)) === 0) return name
    present.push(name)
  }
  return present[0] ?? null
}

/** The live MeetingMinutes of a room, once the server has created it. */
/**
 * `since` is the moment the caller started joining: the previous test's meeting in the same room
 * can still read as Active for a few hundred ms after it was finished, and a test that picks it up
 * then drives a dead meeting - its recordings never appear and the wait burns its whole timeout.
 */
export async function waitRoomMeeting (roomName: string, timeoutMs = 30000, since = 0): Promise<MeetingMinutes> {
  const sys = await getSystemRestClient()
  const room = await sys.findOne(love.class.Room, { name: roomName })
  expect(room).toBeDefined()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mm = await sys.findOne<MeetingMinutes>(love.class.MeetingMinutes, {
      roomId: room?._id,
      status: { $in: [MeetingStatus.Active, MeetingStatus.Pending] },
      ...(since > 0 ? { createdOn: { $gt: since } } : {})
    })
    if (mm !== undefined) return mm
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`No live MeetingMinutes for room ${roomName}`)
}

export async function joinFirstAvailableRoom (page: Page, timeout = 45000): Promise<boolean> {
  const name = await firstAvailableRoom(page)
  if (name === null) return false
  await joinRoom(page, name, timeout)
  return true
}

/**
 * A meeting finishing anywhere navigates its watchers to the MeetingMinutes page, and that
 * navigation can land after the floor was restored. Both pages carry a Connect button, so a window
 * left on the minutes page fails much later, on a connect that can never succeed - every entry into
 * the floor starts by making sure we are actually on it.
 */
async function backToFloorIfLost (page: Page): Promise<void> {
  await dismissPopups(page)
  // The url is not enough: after a meeting ends its client stays on /love with the Summary panel
  // over the grid, and a click on a room then waits out its timeout on a covered element.
  const onFloor =
    onOffice(page) &&
    (await new OfficePage(page)
      .floorGrid()
      .isVisible()
      .catch(() => false))
  if (onFloor) return
  await openLove(page)
}

export async function clickRoomByName (page: Page, name: string): Promise<void> {
  // Any open panel covers the card below it - the minutes page a previous test left open swallows
  // the click through its table cells.
  const panel = page.locator('[data-id="room-panel"], div.panel-instance')
  if ((await panel.count()) > 0) {
    await page.keyboard.press('Escape').catch(() => undefined)
    const gone = await panel
      .first()
      .waitFor({ state: 'hidden', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
    // Escape misses a panel opened through the URL, and `ensureOffice` skips the navigation.
    if (!gone) await openLove(page)
  }
  await backToFloorIfLost(page)
  // Two waits, not one: the card can be slow to render (wait for it), or rendered and covered by a
  // panel (fail fast and let the caller retry from the floor). One combined timeout cannot tell
  // those apart and spends the same 15s on both.
  const card = page.locator(`[data-id="room-${name}"]`).first()
  await card.waitFor({ state: 'visible', timeout: 20000 })
  await card.click({ timeout: 10000 })
}

export async function clickFirstAvailableRoom (page: Page, exclude: string[] = []): Promise<string | null> {
  const name = await firstAvailableRoom(page, exclude)
  if (name === null) return null
  await clickRoomByName(page, name)
  return name
}
