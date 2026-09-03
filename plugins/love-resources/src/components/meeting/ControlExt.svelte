<!--
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
-->
<script lang="ts">
  import { IdMap, Ref, toIdMap } from '@hcengineering/core'
  import { isOffice, ParticipantInfo, Room, MeetingMinutes } from '@hcengineering/love'
  import { getMetadata, translateCB } from '@hcengineering/platform'
  import presentation, { getClient } from '@hcengineering/presentation'
  import { closePopup, eventToHTMLElement, location, showPopup, closeTooltip, themeStore } from '@hcengineering/ui'
  import type { Location } from '@hcengineering/ui'
  import { onDestroy } from 'svelte'
  import workbench from '@hcengineering/workbench'
  import { closeWidget, sidebarStore } from '@hcengineering/workbench-resources'

  import love from '../../plugin'
  import { currentRoom, infos, myInfo, myConnectingSessionId, rooms, meetings, busyPersons } from '../../stores'
  import { createMeetingWidget, getRoomName, liveKitClient } from '../../utils'
  import PersonActionPopup from '../PersonActionPopup.svelte'
  import RoomButton from '../RoomButton.svelte'
  import { lkIsConnecting, lkSessionConnected } from '../../liveKitClient'
  import RoomPopup from '../RoomPopup.svelte'
  import { currentMeeting, leaveMeeting } from '../../meetings'

  const client = getClient()

  interface ActiveRoom extends Room {
    participants: ParticipantInfo[]
    meeting: Ref<MeetingMinutes>
  }

  function getActiveMeetings (rooms: Room[], infos: ParticipantInfo[], meetings: MeetingMinutes[]): ActiveRoom[] {
    const roomMap = toIdMap(rooms)
    const map: IdMap<ActiveRoom> = new Map()

    // Group participants by their meeting to find active meetings
    const participantsByMeeting = new Map<Ref<MeetingMinutes>, ParticipantInfo[]>()
    for (const info of infos) {
      if (info.meeting === undefined) continue
      const existing = participantsByMeeting.get(info.meeting) ?? []
      existing.push(info)
      participantsByMeeting.set(info.meeting, existing)
    }

    for (const [meetingId, participants] of participantsByMeeting) {
      if (participants.length === 0) continue

      // Find the meeting to get room info
      const meeting = meetings.find((m) => m._id === meetingId)
      if (meeting?.roomId === undefined) continue

      // Skip reception
      if (meeting.roomId === love.ids.Reception) continue

      const roomObj = roomMap.get(meeting.roomId)
      if (roomObj === undefined) continue

      const _id = roomObj._id as Ref<ActiveRoom>
      const active = map.get(_id) ?? { ...roomObj, _id, participants: [], meeting: meetingId }
      active.participants.push(...participants)
      map.set(_id, active)
    }

    const arr = Array.from(map.values()).filter(
      (r) => !isOffice(r) || r.participants.length > 1 || r.person !== r.participants[0]?.person
    )
    return arr
  }

  $: activeMeetings = getActiveMeetings($rooms, $infos, $meetings)

  function openRoom (room: ActiveRoom): (e: MouseEvent) => void {
    return (e: MouseEvent) => {
      closeTooltip()
      showPopup(RoomPopup, { room, meetingId: room.meeting }, eventToHTMLElement(e))
    }
  }

  const myInvitesCategory = 'myInvites'

  $: reception = $rooms.find((f) => f._id === love.ids.Reception)

  $: receptionParticipants = $infos.filter((p) => p.room === love.ids.Reception)

  function checkActiveMeeting (
    loc: Location,
    meetingSessionConnected: boolean,
    room: Ref<Room> | undefined,
    hasPendingJoinInThisSession: boolean
  ): void {
    const meetingWidgetState = $sidebarStore.widgetsState.get(love.ids.MeetingWidget)
    const isMeetingWidgetCreated = meetingWidgetState !== undefined

    // If user has a pending join in THIS session or is currently connecting, don't make any decisions yet
    // Pending joins from other browser tabs/sessions should not block this session
    if (hasPendingJoinInThisSession || $lkIsConnecting) {
      return
    }

    if (room === undefined) {
      if (isMeetingWidgetCreated) {
        closeWidget(love.ids.MeetingWidget)
      }
      return
    }

    if (meetingSessionConnected) {
      // Only check room mismatch if we have a valid myRoomAttached (myInfo exists with meeting/room)
      // Otherwise we're still waiting for ParticipantInfo from server webhook
      // Only a ParticipantInfo from *this* LiveKit session proves we were moved out:
      // the row from the previous meeting lingers until its participant_left lands.
      const mySid = liveKitClient.liveKitRoom.localParticipant.sid
      if (
        currentMeeting !== undefined &&
        myRoomAttached !== undefined &&
        myRoomAttached !== room &&
        $myInfo?.sessionId === mySid
      ) {
        void leaveMeeting()
        return
      }
      const widget = client.getModel().findAllSync(workbench.class.Widget, { _id: love.ids.MeetingWidget })[0]
      if (widget === undefined) return

      if (!isMeetingWidgetCreated) {
        createMeetingWidget(widget, room, meetingSessionConnected)
      }
    } else {
      // If user has a ParticipantInfo showing they are in this meeting, keep the widget
      // so they can return after a page reload. Otherwise close the widget.
      if (isMeetingWidgetCreated && myRoomAttached !== room) {
        closeWidget(love.ids.MeetingWidget)
      }
    }
  }

  // Check if pending join is for THIS session (same browser tab)
  $: currentSessionId = getMetadata(presentation.metadata.SessionId)
  $: hasPendingJoinInThisSession = $myConnectingSessionId !== null && $myConnectingSessionId === currentSessionId

  $: checkActiveMeeting($location, $lkSessionConnected, $currentRoom?._id, hasPendingJoinInThisSession)

  let myRoomAttached: Ref<Room> | undefined = undefined
  $: myRoomAttached =
    $myInfo?.meeting !== undefined
      ? ($meetings.find((m) => m._id === $myInfo.meeting)?.roomId as Ref<Room>)
      : $myInfo?.room
  $: joined = activeMeetings.filter((r) => myRoomAttached === r._id)

  // Get busy participants (those in private meetings we don't have access to)
  $: busyParticipants = $infos.filter((info) => $busyPersons.has(info.person) && info.meeting !== undefined)

  // beforeunload used to call leaveMeeting(), which dropped the
  // `love.activeMeeting` anchor in sessionStorage and made post-refresh
  // reconnect impossible. We now rely on:
  //   * LiveKit SDK closing the WebSocket on tab unload,
  //   * server `participant_left` webhook cleaning ParticipantInfo,
  //   * `rememberActiveMeeting` letting the next page-load resume the seat.

  onDestroy(() => {
    closePopup(myInvitesCategory)
    closeWidget(love.ids.MeetingWidget)
  })

  function participantClickHandler (e: MouseEvent, participant: ParticipantInfo): void {
    if ($myInfo !== undefined) {
      showPopup(PersonActionPopup, { room: reception, person: participant.person }, eventToHTMLElement(e))
    }
  }

  function getParticipantClickHandler (participant: ParticipantInfo): (e: MouseEvent) => void {
    return (e: MouseEvent) => {
      participantClickHandler(e, participant)
    }
  }

  let busyLbl: string = ''

  $: translateCB(love.string.Busy, {}, $themeStore.language, (res) => {
    busyLbl = res
  })
</script>

<div class="flex-row-center flex-gap-2">
  {#if activeMeetings.length > 0}
    <!--    <div class="divider" />-->
    {#each activeMeetings as active}
      {#await getRoomName(active) then name}
        <RoomButton
          label={name}
          participants={active.participants}
          active={joined.find((r) => r._id === active._id) != null}
          on:click={openRoom(active)}
        />
      {/await}
    {/each}
  {/if}
  {#if busyParticipants.length > 0}
    {#if activeMeetings.length > 0}
      <div class="divider" />
    {/if}
    <RoomButton label={busyLbl} participants={busyParticipants} />
  {/if}
  {#if reception !== undefined && receptionParticipants.length > 0}
    {#if activeMeetings.length > 0 || busyParticipants.length > 0}
      <div class="divider" />
    {/if}
    {#await getRoomName(reception) then name}
      <RoomButton
        label={name}
        participants={receptionParticipants.map((p) => ({ ...p, onclick: getParticipantClickHandler(p) }))}
      />
    {/await}
  {/if}
</div>

<style lang="scss">
  .divider {
    height: 1.5rem;
    border: 1px solid var(--theme-divider-color);
  }
</style>
