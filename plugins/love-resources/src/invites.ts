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

import { getCurrentEmployee, getCurrentEmployeeSpace, type Person } from '@hcengineering/contact'
import { getPersonByPersonRef } from '@hcengineering/contact-resources'
import { AccountRole, getCurrentAccount, type AccountUuid, type Ref } from '@hcengineering/core'
import love, { MeetingStatus, type MeetingMinutes, type Room, type UserMeetingInvite } from '@hcengineering/love'
import presentation, { createQuery, getClient, onClient, playSound } from '@hcengineering/presentation'
import { addNotification, NotificationSeverity, type PopupResult } from '@hcengineering/ui'
import { getMetadata, translate } from '@hcengineering/platform'
import { getCurrentLanguage } from '@hcengineering/theme'
import { derived, get, writable, type Writable } from 'svelte/store'
import { createMeeting, joinOrCreateMeetingByInvite } from './meetings'
import { currentMeetingMinutes, infos, meetings as meetingsStore } from './stores'
import KnockResolutionToast from './components/meeting/invites/KnockResolutionToast.svelte'

// Half of the server-side TransientTTL=30s. Sender bumps the document
// every tick to keep the TTL fresh; server proxies the touch to every
// linked invite-response. See docs/knock.md.
const HEARTBEAT_MS = 15_000

let heartbeatTimer: ReturnType<typeof setInterval> | undefined

let requestPopup: PopupResult | undefined
let responsePopup: PopupResult | undefined

export const allInvites: Writable<UserMeetingInvite[]> = writable([])

// `derived` re-runs on every `infos` change, so without this the same removeDoc fires on each tick.
const droppedInvites = new Set<Ref<UserMeetingInvite>>()

// All invites we send to somebody.
export const outgoingInvitesStore = derived([allInvites, infos], ([all, allInfos]) => {
  const me = getCurrentEmployee()
  const outgoing = all.filter((it) => it.kind === 'invite-request' && it.from === me)
  void checkAndJoinIfRecipientJoined(outgoing)

  // If the recipient is already a participant of the invited meeting (joined
  // any way — accept, link, room click), drop our own invite-request: there
  // is nothing left to wait for.
  const toDrop = outgoing.filter(
    (it) =>
      it.status === 'pending' &&
      it.meeting !== undefined &&
      it.room === undefined &&
      allInfos.some((p) => p.person === it.to && p.meeting === it.meeting)
  )
  if (toDrop.length > 0) {
    const client = getClient()
    for (const inv of toDrop) {
      if (droppedInvites.has(inv._id)) continue
      droppedInvites.add(inv._id)
      client.removeDoc(love.class.UserMeetingInvite, inv.space, inv._id).catch((): void => {
        droppedInvites.delete(inv._id)
      })
    }
  }
  // Forget invites that are gone, so the guard cannot grow for the life of the tab.
  for (const id of droppedInvites) {
    if (!all.some((it) => it._id === id)) droppedInvites.delete(id)
  }

  return outgoing.filter((it) => it.status === 'pending')
})

// All waiting for confirmation (Scenario A only).
export const incomingInvitesStore = derived(allInvites, (all) => {
  const me = getCurrentEmployee()
  const incoming = all.filter(
    (it) => it.kind === 'invite-response' && it.to === me && it.room === undefined && it.status === 'pending'
  )

  if (incoming.length > 0 && stopIncomingSound == null) {
    stopIncomingSound = playIncomingSound()
  } else if (incoming.length === 0 && stopIncomingSound != null) {
    void stopIncomingInviteSound()
  }

  // A2: caller patches our invite-response with `meeting` after creating one
  // in their office. Auto-join via the same liveQuery snapshot.
  const acceptedWithMeeting = all.filter(
    (it) =>
      it.kind === 'invite-response' &&
      it.to === me &&
      it.room === undefined &&
      it.status === 'accepted' &&
      it.meeting !== undefined
  )
  if (acceptedWithMeeting.length > 0) {
    void checkAndJoinIfRecipientAccepted(acceptedWithMeeting)
  }

  return incoming
})

// Pending Б-flow invite-response addressed to me as a meeting owner.
export const knockingInvitesStore = derived(allInvites, (all) => {
  const me = getCurrentEmployee()
  return all.filter(
    (it) => it.kind === 'invite-response' && it.to === me && it.room !== undefined && it.status === 'pending'
  )
})

// Active sound stop function
let stopIncomingSound: Promise<(() => void) | null> | undefined

// Query for incoming invite-response (created by server trigger in recipient's space)
const incomingInvitesQuery = createQuery(true)

export interface InviteRequest {
  from: Ref<Person>
  meetingId: string
}

export interface InviteResponse {
  from: Ref<Person>
  meetingId: string
  accept: boolean
}

/**
 * Send meeting invites to multiple persons (Scenario A).
 * Shows popup for sender with cancel button.
 */
export async function sendInvites (persons: Array<Ref<Person>>, meeting?: Ref<MeetingMinutes>): Promise<void> {
  if (getCurrentAccount().role === AccountRole.ReadOnlyGuest) {
    return
  }

  const currentPerson = getCurrentEmployee()
  if (currentPerson === undefined) {
    return
  }

  // Filter out self-invites
  const validPersons = persons.filter((p) => p !== currentPerson)
  if (validPersons.length === 0) {
    return
  }

  closeInvitesPopup()

  // Check if we're in a meeting
  const meetingId = meeting ?? get(currentMeetingMinutes)?._id

  const mySpace = getCurrentEmployeeSpace()

  if (mySpace === undefined) {
    return
  }

  const client = getClient()

  // Inviting into an existing private meeting requires ownership: only owners
  // may grow a private space's members (mirrors SpaceSecurityMiddleware and the
  // server-side OnUserMeetingInvite check). A non-owner must use knock instead,
  // so refuse here rather than create an invite-request the server silently
  // drops.
  if (meetingId !== undefined) {
    const meetingDoc =
      meeting !== undefined
        ? await client.findOne(love.class.MeetingMinutes, { _id: meetingId })
        : get(currentMeetingMinutes)
    if (meetingDoc?.private === true) {
      const myAccount = getCurrentAccount().uuid
      if (!(meetingDoc.owners ?? []).includes(myAccount)) {
        addNotification(
          await translate(love.string.Meeting, {}, getCurrentLanguage()),
          await translate(love.string.OnlyOwnersCanInvite, {}, getCurrentLanguage()),
          KnockResolutionToast,
          undefined,
          NotificationSeverity.Warning,
          'love'
        )
        return
      }
    }
  }
  for (const person of validPersons) {
    // Use per-person apply with notMatch to prevent duplicate pending invites
    const apply = client.apply('create-invite:' + currentPerson + ':' + person)
    apply.notMatch(love.class.UserMeetingInvite, {
      kind: 'invite-request',
      from: currentPerson,
      to: person,
      status: 'pending'
    })
    await apply.createDoc(love.class.UserMeetingInvite, mySpace, {
      kind: 'invite-request',
      from: currentPerson,
      to: person,
      status: 'pending',
      ...(meetingId !== undefined && { meeting: meetingId })
    })
    await apply.commit()
  }
}

/**
 * Send a knock request to the owners of a private meeting in `roomId`
 * (Scenario Б). `to` is set to `from` because the real recipients are
 * resolved server-side from meeting owners.
 */
export async function sendKnockRequest (roomId: Ref<Room>): Promise<void> {
  if (getCurrentAccount().role === AccountRole.ReadOnlyGuest) return
  const currentPerson = getCurrentEmployee()
  if (currentPerson === undefined) return
  const mySpace = getCurrentEmployeeSpace()
  if (mySpace === undefined) return

  const client = getClient()
  const apply = client.apply('create-knock:' + currentPerson + ':' + roomId)
  apply.notMatch(love.class.UserMeetingInvite, {
    kind: 'invite-request',
    from: currentPerson,
    room: roomId,
    status: 'pending'
  })
  await apply.createDoc(love.class.UserMeetingInvite, mySpace, {
    kind: 'invite-request',
    from: currentPerson,
    to: currentPerson,
    room: roomId,
    status: 'pending'
  })
  await apply.commit()
}

/**
 * Close the invite request popup
 */
export function closeInvitesPopup (): void {
  requestPopup?.close()
  requestPopup = undefined
}

/**
 * Close the invite response popup
 */
export function closeResponsePopup (): void {
  responsePopup?.close()
  responsePopup = undefined
}

/**
 * Cancel all invites for a meeting
 */
export async function cancelInvites (
  meetingId: Ref<MeetingMinutes> | undefined,
  invites: UserMeetingInvite[]
): Promise<void> {
  const client = getClient()
  const currentPerson = getCurrentEmployee()
  if (currentPerson === undefined) return

  try {
    // Cancel them
    for (const invite of invites) {
      await client.remove(invite)
    }
  } catch (error) {
    console.warn('Failed to cancel invites:', error)
  }

  closeInvitesPopup()
}

/**
 * Subscribe to incoming meeting invites.
 */
export function subscribeToIncomingInvites (): void {
  onClient(() => {
    const trySubscribe = (): void => {
      const mySpace = getCurrentEmployeeSpace()
      if (mySpace === undefined) {
        setTimeout(trySubscribe, 100)
        return
      }

      incomingInvitesQuery.query(love.class.UserMeetingInvite, { space: mySpace }, (invites) => {
        allInvites.set(invites)
      })

      if (heartbeatTimer === undefined) {
        heartbeatTimer = setInterval(() => {
          void renewOutgoingInvites()
        }, HEARTBEAT_MS)
      }
    }
    trySubscribe()
  })
}

async function renewOutgoingInvites (): Promise<void> {
  const me = getCurrentEmployee()
  if (me === undefined) return
  const client = getClient()
  const all = get(allInvites)
  for (const invite of all) {
    if (invite.kind !== 'invite-request' || invite.from !== me) continue
    if (invite.status !== 'pending') continue
    try {
      // No-op update — only the TxUpdateDoc matters; server-side trigger
      // proxies the TTL touch to every linked invite-response. Repeat the
      // existing `status` value so the update is well-typed.
      await client.update(invite, { status: invite.status })
    } catch {
      // Best effort — invite may have been removed concurrently.
    }
  }
}

/**
 * Recipient-side waiting state for Scenario A2 ("we accepted, waiting for
 * caller to create the meeting"). Keyed by the caller's Person ref so we
 * can match the freshly-created MeetingMinutes (it is hosted in caller's
 * office, with both members in `members`). The IncomingInvitePopup uses
 * this store to switch the Join button to a "Waiting for X..." label.
 */
export interface AwaitingMeeting {
  from: Ref<Person>
  acceptedSessionId: string | undefined
}

export const awaitingMeetingStore: Writable<AwaitingMeeting[]> = writable([])

function addAwaiting (entry: AwaitingMeeting): void {
  const list = get(awaitingMeetingStore)
  if (list.some((it) => it.from === entry.from)) return
  awaitingMeetingStore.set([...list, entry])
}

function removeAwaiting (from: Ref<Person>): void {
  awaitingMeetingStore.set(get(awaitingMeetingStore).filter((it) => it.from !== from))
}

/**
 * Watcher driven by the `meetings` live-query: when a meeting in the
 * caller's office appears with both me and the caller as members, auto-join
 * it. This is how the recipient lands in the A2 meeting created by the
 * caller after our `responseToInviteRequest(accept)`.
 */
let stopAwaitingWatch: (() => void) | undefined
function startAwaitingWatcher (): void {
  if (stopAwaitingWatch !== undefined) return
  const handled = new Set<Ref<MeetingMinutes>>()
  stopAwaitingWatch = meetingsStore.subscribe((all) => {
    const awaiting = get(awaitingMeetingStore)
    if (awaiting.length === 0) return
    const me = getCurrentEmployee()
    if (me === undefined) return
    const mySessionId = getMetadata(presentation.metadata.SessionId) ?? undefined
    void (async () => {
      for (const entry of awaiting) {
        if (entry.acceptedSessionId !== undefined && entry.acceptedSessionId !== mySessionId) continue
        const callerPerson = await getPersonByPersonRef(entry.from)
        const callerAccount = callerPerson?.personUuid as AccountUuid | undefined
        const myPerson = await getPersonByPersonRef(me)
        const myAccount = myPerson?.personUuid as AccountUuid | undefined
        if (callerAccount === undefined || myAccount === undefined) continue
        const meeting = all.find(
          (m) =>
            m.status !== MeetingStatus.Finished && m.members.includes(myAccount) && m.members.includes(callerAccount)
        )
        if (meeting === undefined || handled.has(meeting._id)) continue
        handled.add(meeting._id)
        removeAwaiting(entry.from)
        try {
          const currentMm = get(currentMeetingMinutes)
          if (currentMm?._id !== meeting._id) {
            await joinOrCreateMeetingByInvite(meeting._id)
          }
        } catch (err) {
          console.warn('Failed to auto-join awaited meeting', err)
        }
      }
    })()
  })
}

/**
 * Respond to an invite request (accept or decline).
 *  - A1 (`invite.meeting !== undefined`): join immediately and flip status.
 *  - A2 (no meeting): flip status + register an awaiting watch. The popup
 *    keeps a "Waiting for X..." label until the caller's office hosts a
 *    meeting we are a member of; we then auto-join.
 */
export async function responseToInviteRequest (invite: UserMeetingInvite, accept: boolean): Promise<void> {
  const client = getClient()
  const me = getCurrentEmployee()
  if (me === undefined) return

  try {
    if (accept) {
      const acceptedSessionId = getMetadata(presentation.metadata.SessionId) ?? undefined
      if (invite.meeting !== undefined) {
        await joinOrCreateMeetingByInvite(invite.meeting)
        await client.update(invite, { status: 'accepted', acceptedSessionId })
      } else {
        addAwaiting({ from: invite.from, acceptedSessionId })
        startAwaitingWatcher()
        await client.update(invite, { status: 'accepted', acceptedSessionId })
      }
    } else {
      await client.update(invite, { status: 'declined' })
    }
  } catch (error) {
    console.warn('Failed to respond to invite:', error)
  }
}

/**
 * Cancel an awaiting accept (recipient changed their mind before the caller
 * created the meeting).
 */
export function cancelAwaiting (from: Ref<Person>): void {
  removeAwaiting(from)
}

/**
 * Play sound for incoming invites
 */
async function playIncomingSound (): Promise<(() => void) | null> {
  try {
    // Stop previous sound if playing
    await stopIncomingInviteSound()
    return (await playSound(love.sound.Knock, true)) ?? null
  } catch (err) {
    console.error('Error playing sound:', err)
  }
  return null
}

/**
 * Stop incoming invite sound
 */
export async function stopIncomingInviteSound (): Promise<void> {
  if (stopIncomingSound != null) {
    const stop = await stopIncomingSound
    stop?.()
    stopIncomingSound = undefined
  }
}

/**
 * Unsubscribe from incoming invites
 */
export function unsubscribeFromIncomingInvites (): void {
  incomingInvitesQuery.unsubscribe()
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
}

const handlingInvites = new Set<Ref<UserMeetingInvite>>()
const handlingAccepted = new Set<Ref<UserMeetingInvite>>()

/**
 * Recipient-side auto-join after caller (A2) created the meeting and the
 * trigger synced `meeting` onto our invite-response.
 */
export async function checkAndJoinIfRecipientAccepted (invites: UserMeetingInvite[]): Promise<void> {
  const client = getClient()
  const mySessionId = getMetadata(presentation.metadata.SessionId) ?? undefined
  for (const invite of invites) {
    if (invite.meeting === undefined) continue
    if (invite.status !== 'accepted') continue
    if (invite.acceptedSessionId !== undefined && invite.acceptedSessionId !== mySessionId) continue
    if (handlingAccepted.has(invite._id)) continue
    handlingAccepted.add(invite._id)
    let joined = false
    try {
      const currentMeeting = get(currentMeetingMinutes)
      if (currentMeeting?._id === invite.meeting) {
        joined = true
      } else {
        joined = await joinOrCreateMeetingByInvite(invite.meeting)
      }
    } catch (err) {
      console.warn('Failed to auto-join via meeting', err)
    } finally {
      if (joined) {
        try {
          await client.removeDoc(love.class.UserMeetingInvite, invite.space, invite._id)
        } catch {}
      }
      handlingAccepted.delete(invite._id)
    }
  }
}

/**
 * Sender-side watcher for invite-request transitions.
 *  - A1 (meeting set, accepted): join meeting, remove invite-request.
 *  - A2 (no meeting, accepted): caller-client creates MeetingMinutes in MY
 *    office, pushes the recipient as a member, connects, removes invite-request.
 *  - Б (knock, accepted with meeting set by trigger): connect, remove invite.
 *  - declined: show toast, remove invite-request.
 */
export async function checkAndJoinIfRecipientJoined (invites: UserMeetingInvite[]): Promise<void> {
  const client = getClient()
  const me = getCurrentEmployee()
  if (me === undefined) return

  for (const invite of invites) {
    if (handlingInvites.has(invite._id)) continue
    if (invite.status === 'accepted') {
      handlingInvites.add(invite._id)
      try {
        if (invite.meeting === undefined && invite.room === undefined) {
          // A2: caller-client creates the meeting in their own office. `createMeeting`
          // already connects via `connectToMeeting`. Push the recipient as a
          // member so their live-query on `meetingsStore` (members ⊇ [me,
          // caller]) picks the meeting up and auto-joins.
          const office = await client.findOne(love.class.Office, { person: me })
          if (office !== undefined) {
            const outcome = await createMeeting(office)
            if ('meeting' in outcome) {
              const created = outcome.meeting
              const recipient = await getPersonByPersonRef(invite.to)
              const recipientAccount = recipient?.personUuid as AccountUuid | undefined
              if (recipientAccount !== undefined && !created.members.includes(recipientAccount)) {
                await client.update(created, { $push: { members: recipientAccount } })
              }
            }
          }
        } else if (invite.meeting !== undefined) {
          // A1 / Б: meeting ref already set on the request. Connect if not in.
          const currentMeeting = get(currentMeetingMinutes)
          if (currentMeeting?._id !== invite.meeting) {
            await joinOrCreateMeetingByInvite(invite.meeting)
          }
        }
        await client.removeDoc(love.class.UserMeetingInvite, invite.space, invite._id)
      } catch (err) {
        console.warn('Failed to auto-join via accepted invite', err)
      } finally {
        handlingInvites.delete(invite._id)
      }
    } else if (invite.status === 'declined') {
      handlingInvites.add(invite._id)
      try {
        if (invite.room !== undefined) {
          addNotification(
            await translate(love.string.KnockingTo, {}, getCurrentLanguage()),
            await translate(love.string.KnockDeclined, {}, getCurrentLanguage()),
            KnockResolutionToast,
            undefined,
            NotificationSeverity.Info,
            'love'
          )
        } else {
          const recipient = await getPersonByPersonRef(invite.to)
          const name = recipient?.name ?? ''
          addNotification(
            await translate(love.string.CallDeclined, {}, getCurrentLanguage()),
            await translate(love.string.CallDeclinedBody, { name }, getCurrentLanguage()),
            KnockResolutionToast,
            undefined,
            NotificationSeverity.Info,
            'love'
          )
        }
        await client.removeDoc(love.class.UserMeetingInvite, invite.space, invite._id)
      } finally {
        handlingInvites.delete(invite._id)
      }
    }
  }
}

export const inviteRequestSecondsToLive = 30
