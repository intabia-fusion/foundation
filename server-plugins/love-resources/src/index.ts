//
// Copyright © 2024 Hardcore Engineering Inc.
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

import calendar, { Event } from '@hcengineering/calendar'
import contact, { Employee, formatName, Person, PersonSpace } from '@hcengineering/contact'
import core, {
  AccountUuid,
  Class,
  combineAttributes,
  concatLink,
  Data,
  Doc,
  DocumentUpdate,
  generateId,
  readOnlyGuestAccountUuid,
  Ref,
  Space,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxMixin,
  TxProcessor,
  TxUpdateDoc
} from '@hcengineering/core'
import love, {
  isOffice,
  loveId,
  MeetingMinutes,
  MeetingStatus,
  ParticipantInfo,
  Room,
  RoomInfo,
  UserMeetingInvite
} from '@hcengineering/love'
import { getMetadata } from '@hcengineering/platform'
import serverCore, { TriggerControl } from '@hcengineering/server-core'
import view from '@hcengineering/view'
import { workbenchId } from '@hcengineering/workbench'
import { getAccountBySocialId, getSocialStrings } from '@hcengineering/server-contact'
import notification, { CommonInboxNotification } from '@hcengineering/notification'

import { getInviteAllowedProviders } from './utils'
import { Presenter, PresenterControl } from '@hcengineering/server-activity'

export async function OnEmployee (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    let employeeId: Ref<Person> | undefined
    let employee: Employee | undefined

    // Handle TxCreateDoc (direct Employee creation)
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<Employee>
      if (createTx.objectClass === contact.mixin.Employee) {
        employee = TxProcessor.createDoc2Doc(createTx)
        employeeId = createTx.objectId as Ref<Person>
      }
    } else if (tx._class === core.class.TxMixin) {
      // Handle TxMixin (Employee added as mixin to Person) - used by AI bot
      const mixinTx = tx as TxMixin<Person, Employee>
      if (mixinTx.mixin === contact.mixin.Employee) {
        employeeId = mixinTx.objectId
        // Check if employee is being activated
        if (mixinTx.attributes.active !== true) {
          continue
        }
        employee = mixinTx.attributes as Employee
      }
    }

    if (employeeId === undefined || employee === undefined) {
      continue
    }

    // Skip if employee is not active or is a guest
    if (!employee.active) {
      continue
    }
    if (employee.role === 'GUEST') {
      continue
    }

    // Check if employee already has an office
    const existingRooms = await control.findAll(control.ctx, love.class.Office, { person: employeeId })

    if (existingRooms.length > 0) {
      continue
    }

    // Find a free office and assign it
    const freeRoom = (await control.findAll(control.ctx, love.class.Office, { person: null }))[0]
    if (freeRoom !== undefined) {
      result.push(
        control.txFactory.createTxUpdateDoc(freeRoom._class, freeRoom.space, freeRoom._id, {
          person: employeeId
        })
      )
    }
  }
  return result
}

export async function OnUserStatus (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  return []
}

async function roomJoinHandler (info: ParticipantInfo, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  // Participants without a LiveKit sessionId (like AI bot) should not be added to RoomInfo.persons
  // to avoid triggering "room empty" logic when they disconnect (e.g., when stopping transcription)
  if (info.sessionId === null || info.sessionId === undefined) {
    return res
  }

  const roomInfos = await control.queryFind(control.ctx, love.class.RoomInfo, {})

  // Prefer MeetingMinutes association: if a ParticipantInfo references a meeting,
  // use the meeting's attached room as the canonical room for RoomInfo updates.
  let targetRoom = info.room
  if (info.meeting !== undefined) {
    const meeting = (await control.findAll(control.ctx, love.class.MeetingMinutes, { _id: info.meeting }))[0]
    if (meeting?.roomId !== undefined) {
      targetRoom = meeting.roomId
    }
  }

  const roomInfo = roomInfos.find((ri) => ri.room === targetRoom)
  if (roomInfo !== undefined && !roomInfo.persons.includes(info.person)) {
    res.push(
      control.txFactory.createTxUpdateDoc(love.class.RoomInfo, core.space.Workspace, roomInfo._id, {
        $push: { persons: info.person }
      })
    )
  } else {
    const room = (await control.findAll(control.ctx, love.class.Room, { _id: targetRoom }))[0]
    if (room === undefined) return []
    res.push(
      control.txFactory.createTxCreateDoc(love.class.RoomInfo, core.space.Workspace, {
        persons: [info.person],
        room: room._id,
        isOffice: isOffice(room)
      })
    )
  }
  if (info.account != null) {
    const meetingMinutes = (
      await control.findAll(control.ctx, love.class.MeetingMinutes, {
        roomId: info.room,
        status: MeetingStatus.Active
      })
    )[0]
    if (meetingMinutes !== undefined) {
      const colab = await control.findAll(control.ctx, core.class.Collaborator, {
        attachedTo: meetingMinutes._id,
        collaborator: info.account
      })
      if (colab.length === 0) {
        res.push(
          control.txFactory.createTxCreateDoc(core.class.Collaborator, core.space.Workspace, {
            attachedTo: meetingMinutes._id,
            attachedToClass: meetingMinutes._class,
            collection: 'collaborators',
            collaborator: info.account
          })
        )
      }
    }
  }
  return res
}

async function dropRoomInfoOnLeave (info: ParticipantInfo, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  const roomInfos = await control.queryFind(control.ctx, love.class.RoomInfo, {})
  const oldRoomInfo = roomInfos.find((ri) => ri.persons.includes(info.person))
  if (oldRoomInfo === undefined) return res
  if (oldRoomInfo.persons.length === 1 && oldRoomInfo.persons[0] === info.person) {
    res.push(control.txFactory.createTxRemoveDoc(oldRoomInfo._class, oldRoomInfo.space, oldRoomInfo._id))
  } else {
    res.push(
      control.txFactory.createTxUpdateDoc(love.class.RoomInfo, core.space.Workspace, oldRoomInfo._id, {
        $pull: { persons: info.person }
      })
    )
  }
  return res
}

export async function OnParticipantInfo (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const actualTx = tx as TxCUD<ParticipantInfo>
    if (actualTx._class === core.class.TxCreateDoc) {
      const info = TxProcessor.createDoc2Doc(actualTx as TxCreateDoc<ParticipantInfo>)
      result.push(...(await roomJoinHandler(info, control)))
    }
    if (actualTx._class === core.class.TxRemoveDoc) {
      const removedInfo = control.removedMap.get(actualTx.objectId) as ParticipantInfo
      if (removedInfo === undefined) {
        continue
      }
      result.push(...(await dropRoomInfoOnLeave(removedInfo, control)))
      continue
    }
    if (actualTx._class === core.class.TxUpdateDoc) {
      const newRoom = (actualTx as TxUpdateDoc<ParticipantInfo>).operations.room
      const newMeeting = (actualTx as TxUpdateDoc<ParticipantInfo>).operations.meeting
      if (newRoom === undefined && newMeeting === undefined) {
        continue
      }
      const info = (
        await control.findAll(control.ctx, love.class.ParticipantInfo, { _id: actualTx.objectId }, { limit: 1 })
      )[0]
      if (info === undefined) {
        continue
      }
      result.push(...(await dropRoomInfoOnLeave(info, control)))
      result.push(...(await roomJoinHandler(info, control)))
    }
  }
  return result
}

const meetingMinutesUrlPresenter: Presenter = async (doc: Doc, control: PresenterControl): Promise<string> => {
  const meetingMinutes = doc as MeetingMinutes
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''

  const panelProps = [view.component.EditDoc, meetingMinutes._id, meetingMinutes._class]
  const fragment = encodeURIComponent(panelProps.join('|'))
  const path = `${workbenchId}/${control.workspace.url}/${loveId}#${fragment}`
  return concatLink(front, path)
}

async function OnRoomInfo (txes: TxCUD<RoomInfo>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  const personsByRoom = new Map<Ref<RoomInfo>, Ref<Person>[]>()
  for (const tx of txes) {
    if (tx._class === core.class.TxRemoveDoc) {
      const roomInfo = control.removedMap.get(tx.objectId) as RoomInfo
      if (roomInfo === undefined) continue
      if (roomInfo.room === love.ids.Reception) continue
      personsByRoom.delete(tx.objectId)
      // Note: We no longer call finishRoomMeetings here on RoomInfo removal.
      // The love service handles room_finished webhook and finishes the specific meeting by meetingId.
      // Calling finishRoomMeetings here would incorrectly finish ALL active meetings for the room.
      continue
    }
    if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<RoomInfo>
      const pulled = combineAttributes([updateTx.operations], 'persons', '$pull', '$in')
      const pushed = combineAttributes([updateTx.operations], 'persons', '$push', '$each')

      if (pulled.length === 0 && pushed.length === 0) continue
      const roomInfos = await control.queryFind(control.ctx, love.class.RoomInfo, {})
      const roomInfo = roomInfos.find((r) => r._id === tx.objectId)
      if (roomInfo === undefined) continue
      if (roomInfo.room === love.ids.Reception) continue

      const currentPersons = personsByRoom.get(tx.objectId) ?? roomInfo.persons
      const newPersons = currentPersons.filter((p) => !pulled.includes(p)).concat(pushed)

      personsByRoom.set(tx.objectId, newPersons)
    }
  }
  return result
}

async function getPersonSpace (control: TriggerControl, person: Ref<Person>): Promise<PersonSpace> {
  // Find recipient's personal space (PersonSpace)
  return (await control.findAll(control.ctx, contact.class.PersonSpace, { person }, { limit: 1 }))[0]
}

async function findActivePrivateMeetingByRoom (
  control: TriggerControl,
  roomId: Ref<Room>
): Promise<MeetingMinutes | undefined> {
  const meetings = await control.findAll(
    control.ctx,
    love.class.MeetingMinutes,
    { roomId, status: { $in: [MeetingStatus.Active, MeetingStatus.Pending] }, private: true },
    { limit: 1 }
  )
  return meetings[0]
}

async function findResponsesForRequest (
  control: TriggerControl,
  request: UserMeetingInvite
): Promise<UserMeetingInvite[]> {
  if (request.room !== undefined) {
    return await control.findAll(control.ctx, love.class.UserMeetingInvite, {
      kind: 'invite-response',
      from: request.from,
      room: request.room
    })
  }
  return await control.findAll(control.ctx, love.class.UserMeetingInvite, {
    kind: 'invite-response',
    from: request.from,
    to: request.to,
    meeting: request.meeting
  })
}

async function findRequestForResponse (
  control: TriggerControl,
  response: UserMeetingInvite
): Promise<UserMeetingInvite | undefined> {
  if (response.room !== undefined) {
    const list = await control.findAll(
      control.ctx,
      love.class.UserMeetingInvite,
      { kind: 'invite-request', from: response.from, room: response.room },
      { limit: 1 }
    )
    return list[0]
  }
  const list = await control.findAll(
    control.ctx,
    love.class.UserMeetingInvite,
    {
      kind: 'invite-request',
      from: response.from,
      to: response.to,
      meeting: response.meeting
    },
    { limit: 1 }
  )
  return list[0]
}

async function loadInvite (control: TriggerControl, id: Ref<UserMeetingInvite>): Promise<UserMeetingInvite | undefined> {
  const found = (await control.findAll(control.ctx, love.class.UserMeetingInvite, { _id: id }, { limit: 1 }))[0]
  if (found !== undefined) return found
  return control.removedMap.get(id) as UserMeetingInvite | undefined
}

async function findPersonByAccount (control: TriggerControl, account: AccountUuid): Promise<Person | undefined> {
  const persons = await control.findAll<Person>(
    control.ctx,
    contact.class.Person,
    { personUuid: account as unknown as Person['personUuid'] },
    { limit: 1 }
  )
  return persons[0]
}

/**
 * The client dedups pending invite-requests via `notMatch`, but a request that
 * dies by TTL leaves its response behind, so a re-knock would stack a second
 * chip on the recipient. One pending response per (from, to, room/meeting).
 */
async function createInviteResponseTx (
  control: TriggerControl,
  recipientSpace: Ref<Space>,
  data: {
    from: Ref<Person>
    to: Ref<Person>
    meeting?: Ref<MeetingMinutes>
    room?: Ref<Room>
  }
): Promise<Tx | undefined> {
  const existing = await control.findAll(
    control.ctx,
    love.class.UserMeetingInvite,
    {
      kind: 'invite-response',
      from: data.from,
      to: data.to,
      status: 'pending',
      ...(data.room !== undefined ? { room: data.room } : { meeting: data.meeting })
    },
    { limit: 1 }
  )
  if (existing.length > 0) return undefined

  return control.txFactory.createTxCreateDoc(
    love.class.UserMeetingInvite,
    recipientSpace,
    {
      kind: 'invite-response',
      from: data.from,
      to: data.to,
      meeting: data.meeting,
      room: data.room,
      status: 'pending'
    },
    generateId<UserMeetingInvite>()
  )
}

async function createInviteNotificationTxs (
  control: TriggerControl,
  recipientPerson: Ref<Person>,
  recipientSpace: PersonSpace,
  sender: Person | undefined,
  source: UserMeetingInvite,
  modifiedOn: number
): Promise<Tx[]> {
  const result: Tx[] = []
  const employee = (
    await control.findAll(
      control.ctx,
      contact.mixin.Employee,
      { _id: recipientPerson as Ref<Employee>, active: true },
      { limit: 1 }
    )
  )[0]
  if (employee?.personUuid == null) return result
  const account = employee.personUuid
  const socialIds = await getSocialStrings(control, employee._id)
  const allowedProviders = await getInviteAllowedProviders(control, socialIds)

  let notificationObjectId: Ref<Doc>
  let notificationObjectClass: Ref<Class<Doc>>
  let notificationObjectSpace: Ref<Space>
  if (source.meeting !== undefined) {
    const meeting = (
      await control.findAll(control.ctx, love.class.MeetingMinutes, { _id: source.meeting }, { limit: 1 })
    )[0]
    notificationObjectId = meeting?._id ?? source._id
    notificationObjectClass = meeting?._class ?? source._class
    notificationObjectSpace = meeting?.space ?? source.space
  } else {
    notificationObjectId = source.from
    notificationObjectClass = contact.class.Person
    notificationObjectSpace = contact.space.Contacts
  }

  const currentContext = (
    await control.findAll(control.ctx, notification.class.DocNotifyContext, {
      objectId: notificationObjectId,
      user: account
    })
  )[0]
  let contextId = currentContext?._id
  if (contextId === undefined) {
    const createContextTx = control.txFactory.createTxCreateDoc(
      notification.class.DocNotifyContext,
      recipientSpace._id,
      {
        objectId: notificationObjectId,
        objectClass: notificationObjectClass,
        objectSpace: notificationObjectSpace,
        user: account,
        lastNotify: modifiedOn
      }
    )
    contextId = createContextTx.objectId
    result.push(createContextTx)
  } else {
    result.push(
      control.txFactory.createTxUpdateDoc(currentContext._class, currentContext.space, currentContext._id, {
        lastNotify: modifiedOn
      })
    )
  }

  const senderName = sender !== undefined ? formatName(sender.name, control.branding?.lastNameFirst) : 'System'
  // Б flow (knock-to-private-room) — `source.room !== undefined`. The
  // recipient is the meeting owner being asked to admit a stranger, so use
  // the IsKnocking copy ("{name} is knocking..."). Scenario A keeps the
  // InvitingYou wording ("{name} is asking you to join").
  const isKnock = source.room !== undefined
  const messageLabel = isKnock ? love.string.IsKnocking : love.string.InvitingYou
  const data: Data<CommonInboxNotification> = {
    docNotifyContext: contextId,
    user: account,
    message: messageLabel,
    intlParams: { name: senderName, senderName },
    title: love.string.MeetingRequest,
    body: messageLabel,
    header: love.string.MeetingRequest,
    headerIcon: love.icon.Invite,
    objectId: notificationObjectId,
    objectClass: notificationObjectClass,
    isViewed: employee.role === 'GUEST' && account === readOnlyGuestAccountUuid,
    archived: false,
    allowedProviders: Object.fromEntries(allowedProviders.map((provider) => [provider, [love.ids.InviteNotification]]))
  }
  result.push(
    control.txFactory.createTxCreateDoc(notification.class.CommonInboxNotification, recipientSpace._id, { ...data })
  )
  return result
}

/**
 * Unified trigger for UserMeetingInvite.
 *
 * Three flows (see docs/knock.md):
 *   A1/A2 — caller invites a user: trigger fans the invite-request out to a
 *           single invite-response in recipient's PersonSpace + notification.
 *   Б     — caller knocks a private room: trigger looks up the meeting in that
 *           room, fans out one invite-response per owner (fallback: members).
 *   Heartbeat — sender's no-op TxUpdateDoc on invite-request resets TTL on
 *           every linked invite-response.
 *   Accept/Decline — recipient's TxUpdateDoc invite-response syncs status to
 *           the invite-request (and meeting on Б accept, plus $push members).
 *   Cancel  — sender's TxRemoveDoc invite-request removes every linked
 *           invite-response.
 */
export async function OnUserMeetingInvite (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<UserMeetingInvite>
      if (createTx.objectClass !== love.class.UserMeetingInvite) continue

      const invite = TxProcessor.createDoc2Doc(createTx)
      if (invite.kind !== 'invite-request') continue
      if (invite.status !== 'pending') continue
      // Self-invite is only legal for the Б flow (sender places `to = from`
      // because the real recipient is the owner of the locked room).
      if (invite.from === invite.to && invite.room === undefined) continue

      const sender = (await control.findAll(control.ctx, contact.class.Person, { _id: invite.from }, { limit: 1 }))[0]

      if (invite.room !== undefined) {
        // === Scenario B: knock fan-out to all owners ===
        const meeting = await findActivePrivateMeetingByRoom(control, invite.room)
        if (meeting === undefined) continue
        const targets = ((meeting.owners?.length ?? 0) > 0 ? meeting.owners : meeting.members) ?? []
        const seen = new Set<Ref<Person>>()
        for (const ownerAccount of targets) {
          const ownerPerson = await findPersonByAccount(control, ownerAccount)
          if (ownerPerson === undefined) continue
          if (ownerPerson._id === invite.from) continue
          if (seen.has(ownerPerson._id)) continue
          seen.add(ownerPerson._id)
          const ownerSpace = await getPersonSpace(control, ownerPerson._id)
          if (ownerSpace === undefined) continue
          const responseTx = await createInviteResponseTx(control, ownerSpace._id, {
            from: invite.from,
            to: ownerPerson._id,
            room: invite.room,
            meeting: meeting._id
          })
          if (responseTx === undefined) continue
          result.push(responseTx)
          result.push(
            ...(await createInviteNotificationTxs(control, ownerPerson._id, ownerSpace, sender, invite, tx.modifiedOn))
          )
        }
        continue
      }

      // === Scenario A: invite to user ===
      // If the sender references an existing meeting that's private, silently
      // drop the request unless the sender is one of its owners. This mirrors
      // SpaceSecurityMiddleware: only owners can grow members of a private
      // space, so anyone else trying to drag a new person in must use knock.
      if (invite.meeting !== undefined) {
        const target = (
          await control.findAll<MeetingMinutes>(
            control.ctx,
            love.class.MeetingMinutes,
            { _id: invite.meeting },
            { limit: 1 }
          )
        )[0]
        if (target?.private) {
          const senderAccount = sender?.personUuid as AccountUuid | undefined
          const owners = target.owners ?? []
          const isOwner = senderAccount !== undefined && owners.includes(senderAccount)
          if (!isOwner) continue
          // Grow members up-front so the recipient can see the private meeting
          // space immediately. The owner-caller is allowed to do this (mirrors
          // SpaceSecurityMiddleware), and without it the recipient's accept
          // races a membership write that never happens and the join times out
          // with "MeetingMinutes not found".
          const recipient = await control.findAll<Person>(
            control.ctx,
            contact.class.Person,
            { _id: invite.to },
            { limit: 1 }
          )
          const recipientAccount = recipient[0]?.personUuid as AccountUuid | undefined
          if (recipientAccount !== undefined && !target.members.includes(recipientAccount)) {
            result.push(
              control.txFactory.createTxUpdateDoc(love.class.MeetingMinutes, target.space, target._id, {
                $push: { members: recipientAccount }
              })
            )
          }
        }
      }

      const recipientSpace = await getPersonSpace(control, invite.to)
      if (recipientSpace === undefined) continue
      const responseTx = await createInviteResponseTx(control, recipientSpace._id, {
        from: invite.from,
        to: invite.to,
        meeting: invite.meeting
      })
      if (responseTx === undefined) continue
      result.push(responseTx)
      result.push(
        ...(await createInviteNotificationTxs(control, invite.to, recipientSpace, sender, invite, tx.modifiedOn))
      )
      continue
    }

    if (tx._class === core.class.TxRemoveDoc) {
      const removeTx = tx as TxCUD<UserMeetingInvite>
      if (removeTx.objectClass !== love.class.UserMeetingInvite) continue
      const sourceDoc = control.removedMap.get(removeTx.objectId) as UserMeetingInvite | undefined
      if (sourceDoc === undefined) continue
      if (sourceDoc.kind === 'invite-request') {
        // Cancel by sender — drop all linked invite-responses.
        const responses = await findResponsesForRequest(control, sourceDoc)
        for (const r of responses) {
          result.push(control.txFactory.createTxRemoveDoc(love.class.UserMeetingInvite, r.space, r._id))
        }
      }
      continue
    }

    if (tx._class !== core.class.TxUpdateDoc) continue
    const updateTx = tx as TxUpdateDoc<UserMeetingInvite>
    if (updateTx.objectClass !== love.class.UserMeetingInvite) continue
    const sourceDoc = await loadInvite(control, updateTx.objectId)
    if (sourceDoc === undefined) continue

    if (sourceDoc.kind === 'invite-request') {
      // Heartbeat or other no-op update from sender — proxy a TTL touch to
      // every linked invite-response so they live as long as the request.
      const responses = await findResponsesForRequest(control, sourceDoc)
      for (const r of responses) {
        result.push(
          control.txFactory.createTxUpdateDoc<UserMeetingInvite>(love.class.UserMeetingInvite, r.space, r._id, {
            status: r.status
          })
        )
      }
      continue
    }

    // sourceDoc.kind === 'invite-response'
    const newStatus = updateTx.operations.status
    if (newStatus !== 'accepted' && newStatus !== 'declined') continue
    const newSid = updateTx.operations.acceptedSessionId

    if (sourceDoc.room !== undefined) {
      // === Scenario B: owner accepted or declined the knock ===
      const meeting =
        sourceDoc.meeting !== undefined
          ? (await control.findAll(control.ctx, love.class.MeetingMinutes, { _id: sourceDoc.meeting }, { limit: 1 }))[0]
          : undefined
      if (meeting === undefined) continue
      const actorAccount = await getAccountBySocialId(control, updateTx.modifiedBy)
      const owners = meeting.owners ?? []
      const authorized =
        actorAccount !== null &&
        (owners.length > 0 ? owners.includes(actorAccount) : meeting.members.includes(actorAccount))
      if (!authorized) continue

      const request = await findRequestForResponse(control, sourceDoc)

      if (newStatus === 'accepted') {
        const knockerPerson = (
          await control.findAll(control.ctx, contact.class.Person, { _id: sourceDoc.from }, { limit: 1 })
        )[0]
        const knockerAccount = knockerPerson?.personUuid as AccountUuid | undefined
        if (knockerAccount !== undefined && !meeting.members.includes(knockerAccount)) {
          result.push(
            control.txFactory.createTxUpdateDoc(love.class.MeetingMinutes, meeting.space, meeting._id, {
              $push: { members: knockerAccount }
            })
          )
        }
        // Drop every sibling invite-response for this knock — the room is open.
        const siblings = await findResponsesForRequest(control, sourceDoc)
        for (const s of siblings) {
          result.push(control.txFactory.createTxRemoveDoc(love.class.UserMeetingInvite, s.space, s._id))
        }
        if (request !== undefined) {
          const upd: DocumentUpdate<UserMeetingInvite> = { status: 'accepted', meeting: meeting._id }
          if (newSid !== undefined) upd.acceptedSessionId = newSid
          result.push(
            control.txFactory.createTxUpdateDoc(love.class.UserMeetingInvite, request.space, request._id, upd)
          )
        }
      } else {
        // decline by THIS owner — remove only this response.
        result.push(
          control.txFactory.createTxRemoveDoc(love.class.UserMeetingInvite, updateTx.objectSpace, updateTx.objectId)
        )
        // If no responses remain, sync request.status = declined for the knocker.
        if (request !== undefined) {
          const remaining = (await findResponsesForRequest(control, sourceDoc)).filter((r) => r._id !== sourceDoc._id)
          if (remaining.length === 0) {
            result.push(
              control.txFactory.createTxUpdateDoc(love.class.UserMeetingInvite, request.space, request._id, {
                status: 'declined'
              })
            )
          }
        }
      }
      continue
    }

    // === Scenario A: invite-response accept/decline ===
    // Per docs/knock.md: trigger removes the invite-response right away and
    // syncs status (+acceptedSessionId) onto the invite-request. Recipient
    // waits via a separate live-query on MeetingMinutes (members ⊇ [me, from]
    // in the caller's office) and auto-joins when the caller's A2 client
    // creates the meeting.
    result.push(
      control.txFactory.createTxRemoveDoc(love.class.UserMeetingInvite, updateTx.objectSpace, updateTx.objectId)
    )
    const requestA = await findRequestForResponse(control, sourceDoc)
    if (requestA !== undefined) {
      const upd: DocumentUpdate<UserMeetingInvite> = { status: newStatus }
      if (newSid !== undefined) upd.acceptedSessionId = newSid
      result.push(control.txFactory.createTxUpdateDoc(love.class.UserMeetingInvite, requestA.space, requestA._id, upd))
    }
  }

  return result
}

/**
 * Trigger to update MeetingMinutes when Event is updated
 * - Updates meetingScheduledDate when Event date changes
 * - Updates members when Event participants change
 */
export async function OnEventUpdate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (tx._class !== core.class.TxUpdateDoc) continue

    const cudTx = tx as TxCUD<Event>
    if (cudTx.objectClass !== calendar.class.Event) continue

    // Get the event
    const event = (await control.findAll(control.ctx, calendar.class.Event, { _id: cudTx.objectId }, { limit: 1 }))[0]
    if (event === undefined) continue

    // Check if event has MeetingEventLink mixin
    const hasMeetingMixin = control.hierarchy.hasMixin(event, love.mixin.MeetingEventLink)
    if (!hasMeetingMixin) continue

    const meetingLink = control.hierarchy.as(event, love.mixin.MeetingEventLink)
    if (meetingLink.meetingId === undefined) continue

    // Get the meeting
    const meeting = await control.findAll(
      control.ctx,
      love.class.MeetingMinutes,
      { _id: meetingLink.meetingId },
      { limit: 1 }
    )
    if (meeting.length === 0) continue
    const meetingDoc = meeting[0]

    // Only update if meeting is in Scheduled status
    if (meetingDoc.status !== MeetingStatus.Scheduled) continue

    const updateTx = tx as TxUpdateDoc<Event>
    const ops = updateTx.operations
    const meetingUpdate: DocumentUpdate<MeetingMinutes> = {}

    // Update meetingScheduledDate if Event date changed
    if (ops.date !== undefined) {
      meetingUpdate.meetingScheduledDate = ops.date
    }

    // Update members if Event participants changed
    if (ops.participants !== undefined) {
      const newMembers: AccountUuid[] = []

      for (const participantRef of ops.participants) {
        const person = (
          await control.findAll(control.ctx, contact.class.Person, { _id: participantRef as Ref<Person> }, { limit: 1 })
        )[0]
        if (person?.personUuid !== undefined && !meetingDoc.members.includes(person.personUuid as AccountUuid)) {
          newMembers.push(person.personUuid as AccountUuid)
        }
      }

      if (newMembers.length > 0) {
        meetingUpdate.$push = { members: { $each: newMembers, $position: 0 } }
      }
    }

    // Apply update if there are changes
    if (Object.keys(meetingUpdate).length > 0) {
      result.push(
        control.txFactory.createTxUpdateDoc(love.class.MeetingMinutes, meetingDoc.space, meetingDoc._id, meetingUpdate)
      )
    }
  }

  return result
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    MeetingMinutesUrlPresenter: meetingMinutesUrlPresenter
  },
  trigger: {
    OnEmployee,
    OnUserStatus,
    OnParticipantInfo,
    OnRoomInfo,
    OnUserMeetingInvite,
    OnEventUpdate
  }
})
