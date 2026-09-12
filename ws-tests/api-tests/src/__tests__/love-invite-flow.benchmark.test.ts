//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// Soak-test variant of love-invite-flow.test.ts: pushes the invite flow through the live
// ws-tests stand many times (optional parallel batches) to collect per-step latencies,
// flag iterations where a broadcast missed its liveQuery window, and print histograms that
// surface server-side concurrency hot spots. Skipped by default; enable with
// BENCH_INVITE_FLOW=1 (tune via BENCH_INVITE_ITERATIONS / BENCH_INVITE_PARALLEL).

import {
  connect,
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type PlatformClient,
  type RestClient,
  type WorkspaceToken
} from '@hcengineering/api-client'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import core, {
  type Data,
  type DocumentUpdate,
  generateId,
  MeasureMetricsContext,
  pickPrimarySocialId,
  type SocialId,
  systemAccountUuid,
  type Ref,
  type Space
} from '@hcengineering/core'
import contact, { ensureEmployee, type Person, type PersonSpace } from '@hcengineering/contact'
import love, { type MeetingMinutes, type UserMeetingInvite } from '@hcengineering/love'
import { generateToken } from '@hcengineering/server-token'

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:8083'
const WORKSPACE = 'api-tests'
const ITERATIONS = parseInt(process.env.BENCH_INVITE_ITERATIONS ?? '20')
// Per-iteration parallelism. 1 = strictly sequential (matches the manual
// user flow). Higher values fire N iterations at once on the same user
// pair — surfaces server-side concurrency issues (e.g. trigger picking up
// stale meeting members from a sibling cycle).
const PARALLEL = parseInt(process.env.BENCH_INVITE_PARALLEL ?? '1')
const STEP_TIMEOUT_MS = parseInt(process.env.BENCH_INVITE_STEP_TIMEOUT_MS ?? '15000')

// Guard so the benchmark doesn't run in routine CI/test passes.
const dtest = process.env.BENCH_INVITE_FLOW === '1' ? describe : describe.skip

interface IterStats {
  index: number
  parallelBatch: number
  responseDeliveryMs: number
  acceptSyncMs: number
  lazyMeetingPatchMs: number
  cleanupCallerMs: number
  cleanupRecipientMs: number
  totalMs: number
}

dtest('love invite flow benchmark', () => {
  let user1Token: WorkspaceToken
  let user2Token: WorkspaceToken
  let user1Client: PlatformClient
  let user2Client: PlatformClient
  let user1Rest: RestClient
  let user2Rest: RestClient
  let systemRest: RestClient
  let user1Person: Person
  let user2Person: Person
  let user1Space: PersonSpace
  let user2Space: PersonSpace
  const createdMeetings: Array<Ref<MeetingMinutes>> = []

  beforeAll(async () => {
    const config = await loadServerConfig(PLATFORM_URL)
    user1Token = await getWorkspaceToken(
      PLATFORM_URL,
      { email: 'user1', password: '1234', workspace: WORKSPACE },
      config
    )
    user2Token = await getWorkspaceToken(
      PLATFORM_URL,
      { email: 'user2', password: '1234', workspace: WORKSPACE },
      config
    )

    user1Client = await connect(PLATFORM_URL, { email: 'user1', password: '1234', workspace: WORKSPACE })
    user2Client = await connect(PLATFORM_URL, { email: 'user2', password: '1234', workspace: WORKSPACE })
    user1Rest = createRestClient(user1Token.endpoint, user1Token.workspaceId, user1Token.token)
    user2Rest = createRestClient(user2Token.endpoint, user2Token.workspaceId, user2Token.token)
    systemRest = createRestClient(
      user1Token.endpoint,
      user1Token.workspaceId,
      generateToken(systemAccountUuid, user1Token.workspaceId, undefined, 'secret')
    )

    // ensureEmployee for both — api-client.connect doesn't.
    const ensureFor = async (tok: WorkspaceToken): Promise<void> => {
      const accClient = getAccountClient(config.ACCOUNTS_URL, tok.token)
      const person = await accClient.getPerson()
      const socialIds: SocialId[] = await accClient.getSocialIds(true)
      const txConn = await createRestTxOperations(tok.endpoint, tok.workspaceId, tok.token)
      await ensureEmployee(
        new MeasureMetricsContext('test', {}),
        {
          uuid: tok.info.account,
          role: tok.info.role,
          primarySocialId: pickPrimarySocialId(socialIds)._id,
          socialIds: socialIds.map((si) => si._id),
          fullSocialIds: socialIds
        },
        txConn,
        socialIds,
        async () => person
      )
    }
    await ensureFor(user1Token)
    await ensureFor(user2Token)

    user1Person = (
      await systemRest.findAll(contact.class.Person, {
        personUuid: user1Token.info.account as any
      })
    )[0]
    user2Person = (
      await systemRest.findAll(contact.class.Person, {
        personUuid: user2Token.info.account as any
      })
    )[0]

    const waitForSpace = async (personId: Ref<Person>): Promise<PersonSpace> => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const found = await systemRest.findAll(contact.class.PersonSpace, { person: personId })
        if (found.length > 0) return found[0]
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`PersonSpace for ${personId} not created within 10s`)
    }
    user1Space = await waitForSpace(user1Person._id)
    user2Space = await waitForSpace(user2Person._id)
  }, 30000)

  afterAll(async () => {
    for (const m of createdMeetings) {
      try {
        await systemRest.removeDoc(love.class.MeetingMinutes, core.space.Space, m)
      } catch {}
    }
    await user1Client.close?.()
    await user2Client.close?.()
  })

  // One persistent liveQuery per side for the whole benchmark — re-creating
  // queries per iteration would dwarf the actual server work in latency.
  // We just scan the latest snapshot for the iteration's invite ids.
  function setupWatcher (
    client: PlatformClient,
    space: Ref<Space>
  ): { snapshot: () => UserMeetingInvite[], stop: () => void } {
    let latest: UserMeetingInvite[] = []
    const lq = client.createLiveQuery()
    const unsubscribe = lq.query(love.class.UserMeetingInvite, { space }, (res) => {
      latest = res
    })
    return { snapshot: () => latest, stop: unsubscribe }
  }

  async function waitFor (
    label: string,
    snapshot: () => UserMeetingInvite[],
    predicate: (snap: UserMeetingInvite[]) => boolean
  ): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (predicate(snapshot())) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`waitFor[${label}] timed out after ${STEP_TIMEOUT_MS}ms`)
  }

  async function runOneIteration (
    index: number,
    parallelBatch: number,
    callerSnapshot: () => UserMeetingInvite[],
    recipientSnapshot: () => UserMeetingInvite[]
  ): Promise<IterStats> {
    const t0 = Date.now()
    const inviteRequestId = generateId<UserMeetingInvite>()
    // Unique meeting marker so concurrent iterations can disambiguate each
    // other's invite-response on the recipient side. We pretend the caller
    // already had a meeting (A1 flow); benchmark cares about the broadcast
    // path, not the meeting itself.
    const meetingMarker = ('benchmark:meeting:' + index) as unknown as Ref<MeetingMinutes>

    // 1) Create invite-request on caller side.
    const requestData: Data<UserMeetingInvite> = {
      kind: 'invite-request',
      from: user1Person._id,
      to: user2Person._id,
      meeting: meetingMarker,
      status: 'pending'
    }
    await user1Rest.createDoc(love.class.UserMeetingInvite, user1Space._id, requestData, inviteRequestId)

    // 2) Wait for invite-response delivery to recipient.
    const tResponseStart = Date.now()
    let responseId: Ref<UserMeetingInvite> | undefined
    await waitFor(`iter ${index} response delivered`, recipientSnapshot, (snap) => {
      const it = snap.find(
        (i) => i.kind === 'invite-response' && i.from === user1Person._id && i.meeting === meetingMarker
      )
      if (it !== undefined && responseId === undefined) {
        responseId = it._id
      }
      return responseId !== undefined
    })
    const responseDeliveryMs = Date.now() - tResponseStart

    // 3) Recipient accepts.
    const tAcceptStart = Date.now()
    const acceptUpd: DocumentUpdate<UserMeetingInvite> = { status: 'accepted' }
    await user2Rest.updateDoc(
      love.class.UserMeetingInvite,
      user2Space._id,
      responseId as Ref<UserMeetingInvite>,
      acceptUpd
    )

    // 4) Wait for caller-side invite-request sync (status=accepted).
    await waitFor(`iter ${index} caller request synced`, callerSnapshot, (snap) =>
      snap.some((i) => i._id === inviteRequestId && i.status === 'accepted')
    )
    const acceptSyncMs = Date.now() - tAcceptStart

    // 5) Wait for recipient-side invite-response removal (server trigger removes
    //    the response on accept).
    const tRespRemoveStart = Date.now()
    await waitFor(
      `iter ${index} recipient response removed`,
      recipientSnapshot,
      (snap) => !snap.some((i) => i._id === responseId)
    )
    const lazyMeetingPatchMs = Date.now() - tRespRemoveStart

    // 6) Client-driven cleanup: caller removes the invite-request after join.
    await user1Rest.removeDoc(love.class.UserMeetingInvite, user1Space._id, inviteRequestId)

    const tCleanupCallerStart = Date.now()
    await waitFor(
      `iter ${index} caller request removed`,
      callerSnapshot,
      (snap) => !snap.some((i) => i._id === inviteRequestId)
    )
    const cleanupCallerMs = Date.now() - tCleanupCallerStart
    const cleanupRecipientMs = 0

    return {
      index,
      parallelBatch,
      responseDeliveryMs,
      acceptSyncMs,
      lazyMeetingPatchMs,
      cleanupCallerMs,
      cleanupRecipientMs,
      totalMs: Date.now() - t0
    }
  }

  function summarize (samples: number[]): { p50: number, p95: number, p99: number, max: number, avg: number } {
    if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, avg: 0 }
    const sorted = [...samples].sort((a, b) => a - b)
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
    return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1], avg: Math.round(avg) }
  }

  it(
    `runs ${ITERATIONS} iterations (parallel=${PARALLEL})`,
    async () => {
      const callerWatch = setupWatcher(user1Client, user1Space._id)
      const recipientWatch = setupWatcher(user2Client, user2Space._id)
      const stats: IterStats[] = []
      const failures: Array<{ index: number, error: string }> = []

      try {
        const batchCount = Math.ceil(ITERATIONS / PARALLEL)
        const benchStart = Date.now()
        for (let b = 0; b < batchCount; b++) {
          const batchSize = Math.min(PARALLEL, ITERATIONS - b * PARALLEL)
          const indices: number[] = []
          for (let j = 0; j < batchSize; j++) indices.push(b * PARALLEL + j)
          const results = await Promise.allSettled(
            indices.map((i) => runOneIteration(i, b, callerWatch.snapshot, recipientWatch.snapshot))
          )
          for (let j = 0; j < results.length; j++) {
            const r = results[j]
            if (r.status === 'fulfilled') stats.push(r.value)
            else failures.push({ index: indices[j], error: r.reason?.message ?? String(r.reason) })
          }
        }
        const benchMs = Date.now() - benchStart

        // Print a compact histogram. Every step has its own column so a
        // slow tail in any single step (e.g. cleanupRecipient lagging
        // behind cleanupCaller) points straight at the offending broadcast.
        const cols: Array<keyof IterStats> = [
          'responseDeliveryMs',
          'acceptSyncMs',
          'lazyMeetingPatchMs',
          'cleanupCallerMs',
          'cleanupRecipientMs',
          'totalMs'
        ]
        /* eslint-disable no-console */
        console.log(
          `\n[bench] iterations=${ITERATIONS} parallel=${PARALLEL} ok=${stats.length} failed=${failures.length} total=${benchMs}ms (${(ITERATIONS / (benchMs / 1000)).toFixed(1)} ops/s)`
        )
        console.log(
          ['step'.padEnd(24), 'p50', 'p95', 'p99', 'max', 'avg'].map((s) => s.toString().padStart(8)).join(' ')
        )
        for (const col of cols) {
          const samples = stats.map((s) => s[col])
          const sum = summarize(samples)
          console.log(
            [col.toString().padEnd(24), sum.p50, sum.p95, sum.p99, sum.max, sum.avg]
              .map((s) => s.toString().padStart(8))
              .join(' ')
          )
        }
        if (failures.length > 0) {
          console.log('\n[bench] failed iterations:')
          for (const f of failures) console.log(`  - #${f.index}: ${f.error}`)
        }
        /* eslint-enable no-console */

        // Zero tolerance for failed iterations — they indicate a real race.
        expect(failures.length).toBe(0)
      } finally {
        callerWatch.stop()
        recipientWatch.stop()
      }
    },
    10 * 60 * 1000
  )
})
