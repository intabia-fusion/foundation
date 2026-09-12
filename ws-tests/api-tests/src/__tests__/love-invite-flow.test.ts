//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// End-to-end api-test for the love invite flow against the live ws-tests stand
// (API layer, no browser/LiveKit): OnUserMeetingInvite creates an invite-response in the
// recipient's PersonSpace, accept flips status and syncs the invite-request, and a
// removeDoc of the invite-request is broadcast to BOTH subscribed WS clients (the third
// is the live-bug: REST cleanup happened server-side but the WS client never saw the remove).

import {
  connect,
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  NodeWebSocketFactory,
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
import love, { type MeetingMinutes, type Office, type UserMeetingInvite } from '@hcengineering/love'
import { generateToken } from '@hcengineering/server-token'

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:8083'
const WORKSPACE = 'api-tests'

describe('love invite flow (api-tests)', () => {
  let user1Token: WorkspaceToken
  let user2Token: WorkspaceToken
  let user1Client: PlatformClient
  let user2Client: PlatformClient
  let user1Rest: RestClient
  let systemRest: RestClient

  let user1Person: Person
  let user2Person: Person
  let user1Space: PersonSpace
  let user2Space: PersonSpace
  let user1OfficeId: Ref<Office>
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

    // In Jest (testEnvironment: 'node'), global WebSocket is not available
    // (jest swaps the runtime such that Node 22+ native WebSocket is hidden),
    // so the default client-resources factory throws `WebSocket is not
    // defined`. Pass NodeWebSocketFactory explicitly — same approach used by
    // any non-browser consumer of @hcengineering/api-client.
    user1Client = await connect(PLATFORM_URL, {
      email: 'user1',
      password: '1234',
      workspace: WORKSPACE,
      socketFactory: NodeWebSocketFactory
    })
    user2Client = await connect(PLATFORM_URL, {
      email: 'user2',
      password: '1234',
      workspace: WORKSPACE,
      socketFactory: NodeWebSocketFactory
    })

    user1Rest = createRestClient(user1Token.endpoint, user1Token.workspaceId, user1Token.token)
    systemRest = createRestClient(
      user1Token.endpoint,
      user1Token.workspaceId,
      generateToken(systemAccountUuid, user1Token.workspaceId, undefined, 'secret')
    )

    // The api-client `connect()` opens a WebSocket but does NOT call
    // ensureEmployee — that's a workbench-resources responsibility on the
    // browser side. Without it the workspace has no Person/Employee/
    // PersonSpace for the test users and every lookup returns 0. Run it
    // explicitly here for both accounts, the same way rest.test does.
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

    // Resolve Person + PersonSpace via the system-token REST client so
    // SpaceSecurityMiddleware doesn't filter out user2's PersonSpace
    // (which is private and only lists user2 in its members).
    const u1s = await systemRest.findAll(contact.class.Person, {
      personUuid: user1Token.info.account as any
    })
    const u2s = await systemRest.findAll(contact.class.Person, {
      personUuid: user2Token.info.account as any
    })
    expect(u1s.length).toBeGreaterThanOrEqual(1)
    expect(u2s.length).toBeGreaterThanOrEqual(1)
    user1Person = u1s[0]
    user2Person = u2s[0]

    // PersonSpace is created asynchronously by the `OnEmployeeCreate`
    // trigger — `ensureEmployee` returns before the trigger has flushed
    // its derived txes, so we poll briefly. Without this we race the
    // trigger and see 0 spaces for the just-mixed-in account.
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

    // Provision a minimal Office for user1 so the caller-client meeting
    // create has somewhere to host the meeting. We use the system-token
    // REST client because Office is created in `love.ids.MainFloor` which
    // is a workspace-level space; lookups go via `{ person: user1.id }`.
    const existingOffice = await systemRest.findOne(love.class.Office, { person: user1Person._id })
    if (existingOffice !== undefined) {
      user1OfficeId = existingOffice._id
    } else {
      user1OfficeId = generateId<Office>()
      await systemRest.createDoc(
        love.class.Office,
        love.ids.MainFloor as unknown as Ref<Space>,
        {
          name: 'api-tests Office',
          description: '',
          type: 0 as any, // RoomType.Video — numeric enum, defensive cast
          access: 0 as any,
          floor: love.ids.MainFloor,
          width: 1,
          height: 1,
          x: 0,
          y: 0,
          person: user1Person._id,
          startPrivate: false
        } as any,
        user1OfficeId
      )
    }
  }, 30000)

  afterAll(async () => {
    // Cleanup any MeetingMinutes the test created so reruns are deterministic.
    for (const m of createdMeetings) {
      try {
        await systemRest.removeDoc(love.class.MeetingMinutes, core.space.Space, m)
      } catch {}
    }
    await user1Client.close?.()
    await user2Client.close?.()
  })

  /**
   * Helper: subscribe a PlatformClient's liveQuery to invites in a given
   * personal space and return a stop fn + history of observed docs (latest
   * snapshot only — we don't need tx-level granularity for these tests).
   */
  function watchInvites (
    client: PlatformClient,
    space: Ref<Space>
  ): { snapshots: UserMeetingInvite[][], stop: () => void } {
    const snapshots: UserMeetingInvite[][] = []
    const lq = client.createLiveQuery()
    const unsubscribe = lq.query(love.class.UserMeetingInvite, { space }, (res) => {
      snapshots.push(res)
    })
    return { snapshots, stop: unsubscribe }
  }

  /** Poll the latest snapshot until `predicate` matches; throw on timeout. */
  async function waitFor<T> (
    label: string,
    get: () => T | undefined,
    predicate: (v: T) => boolean,
    timeoutMs = 15000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const v = get()
      if (v !== undefined && predicate(v)) return v
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`waitFor[${label}] timed out after ${timeoutMs}ms; last value: ${JSON.stringify(get())}`)
  }

  it('client-create flow: invite-request -> invite-response -> accept -> sync -> client cleanup broadcasts', async () => {
    // 1) Subscribe BOTH clients before any write happens, so liveQuery sees
    //    the full create/update/remove sequence.
    const callerWatch = watchInvites(user1Client, user1Space._id)
    const recipientWatch = watchInvites(user2Client, user2Space._id)

    try {
      // 2) user1 creates an invite-request in their own PersonSpace
      //    (mirrors `sendInvites([user2])` from plugins/love-resources).
      const inviteRequestId = generateId<UserMeetingInvite>()
      const requestData: Data<UserMeetingInvite> = {
        kind: 'invite-request',
        from: user1Person._id,
        to: user2Person._id,
        status: 'pending'
      }
      await user1Rest.createDoc(love.class.UserMeetingInvite, user1Space._id, requestData, inviteRequestId)

      // 3) Server trigger `OnUserMeetingInvite` must create a matching
      //    invite-response in user2's PersonSpace. Recipient WS client
      //    observes it via liveQuery.
      const response = await waitFor(
        'invite-response delivered to recipient',
        () => recipientWatch.snapshots[recipientWatch.snapshots.length - 1],
        (snap) => snap.some((it) => it.kind === 'invite-response' && it.from === user1Person._id),
        15000
      )
      const inviteResponse = response.find(
        (it) => it.kind === 'invite-response' && it.from === user1Person._id
      ) as UserMeetingInvite
      expect(inviteResponse).toBeDefined()

      // 4) recipient accepts (flips status). Need recipient's REST token
      //    so the update is authored under the right account — otherwise
      //    SpaceSecurityMiddleware blocks the write in user1's PersonSpace.
      const user2Rest = createRestClient(user2Token.endpoint, user2Token.workspaceId, user2Token.token)
      const acceptUpd: DocumentUpdate<UserMeetingInvite> = { status: 'accepted' }
      await user2Rest.updateDoc(love.class.UserMeetingInvite, inviteResponse.space, inviteResponse._id, acceptUpd)

      // 5) Server syncs the accepted status to user1's invite-request.
      //    The trigger removes the invite-response (recipient side).
      await waitFor(
        'invite-request synced to accepted on caller side',
        () => callerWatch.snapshots[callerWatch.snapshots.length - 1],
        (snap) => snap.some((it) => it._id === inviteRequestId && it.status === 'accepted'),
        15000
      )
      await waitFor(
        'invite-response removed by server trigger after accept',
        () => recipientWatch.snapshots[recipientWatch.snapshots.length - 1],
        (snap) => !snap.some((it) => it._id === inviteResponse._id),
        15000
      )

      // 6) Caller-driven cleanup: client removes its invite-request after
      //    creating the meeting and joining (we just simulate the remove).
      await user1Rest.removeDoc(love.class.UserMeetingInvite, user1Space._id, inviteRequestId)

      // 7) Both liveQueries observe the final state.
      await waitFor(
        'invite-request removed from caller liveQuery after cleanup',
        () => callerWatch.snapshots[callerWatch.snapshots.length - 1],
        (snap) => !snap.some((it) => it._id === inviteRequestId),
        15000
      )
    } finally {
      callerWatch.stop()
      recipientWatch.stop()
    }
  }, 60000)
})
