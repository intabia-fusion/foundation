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

import { type Person } from '@hcengineering/contact'
import { type MeasureContext, type Ref, type WorkspaceUuid } from '@hcengineering/core'
import { type MeetingMinutes } from '@hcengineering/love'
import { type RoomServiceClient } from 'livekit-server-sdk'

import { getRoomName } from './utils'
import { type WorkspaceClient } from './workspaceClient'

/**
 * One person, one meeting. A second tab joining elsewhere leaves the first room occupied by a
 * session nobody can see - the client store collapses both rows of one person into the newest -
 * so that room stays open until the tab is closed. Called once the joiner is really connected:
 * evicting on `/getToken` would drop the old meeting even when the new connection then fails.
 *
 * The claim is only honoured for a person LiveKit already reports in `meetingId`, so a forged
 * `_id` cannot be used to kick somebody out of their meeting.
 */
export async function claimSession (
  ctx: MeasureContext,
  roomClient: RoomServiceClient,
  wsClient: WorkspaceClient,
  workspaceId: WorkspaceUuid,
  person: Ref<Person>,
  meetingId: Ref<MeetingMinutes>
): Promise<number> {
  const claimed = await isInRoom(ctx, roomClient, getRoomName(workspaceId, meetingId), person)
  if (!claimed) {
    ctx.warn('Refusing a session claim for a meeting the person is not in', { person, meetingId })
    return 0
  }

  const seats = await wsClient.findParticipantInfosByPerson(person)
  let evicted = 0
  for (const seat of seats) {
    if (seat.meeting === meetingId) continue
    const other = getRoomName(workspaceId, seat.meeting)
    try {
      // The `participant_left` webhook drops the ParticipantInfo, so no DB write here.
      await roomClient.removeParticipant(other, person)
      evicted++
      ctx.info('Evicted a session in another meeting', { person, from: seat.meeting, to: meetingId })
    } catch (err: any) {
      // Already gone from LiveKit - the row is stale and polling sweeps it.
      ctx.info('Nothing to evict in another meeting', { person, roomName: other, reason: err?.message })
    }
  }
  return evicted
}

/**
 * Which of `candidates` really hold this person in LiveKit right now. A ParticipantInfo row
 * outlives a closed tab by `departureTimeout`, so the row alone cannot tell a live second session
 * from one that is already gone - only LiveKit can.
 */
export async function liveSessionsOf (
  ctx: MeasureContext,
  roomClient: RoomServiceClient,
  workspaceId: WorkspaceUuid,
  person: Ref<Person>,
  candidates: Array<Ref<MeetingMinutes>>
): Promise<Array<Ref<MeetingMinutes>>> {
  const live: Array<Ref<MeetingMinutes>> = []
  for (const meeting of candidates) {
    if (await isInRoom(ctx, roomClient, getRoomName(workspaceId, meeting), person)) {
      live.push(meeting)
    }
  }
  return live
}

async function isInRoom (
  ctx: MeasureContext,
  roomClient: RoomServiceClient,
  roomName: string,
  person: Ref<Person>
): Promise<boolean> {
  try {
    const participants = await roomClient.listParticipants(roomName)
    return participants.some((it) => it.identity === person)
  } catch (err: any) {
    ctx.warn('Failed to verify a session claim', { error: err?.message ?? String(err), roomName })
    return false
  }
}
