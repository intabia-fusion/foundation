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
  import { EditBox, ModernButton } from '@hcengineering/ui'
  import {
    Room,
    isOffice,
    MeetingStatus,
    isScheduledJoinable,
    type MeetingMinutes,
    type ParticipantInfo
  } from '@hcengineering/love'
  import { createEventDispatcher, onMount } from 'svelte'
  import { getMetadata, IntlString } from '@hcengineering/platform'
  import presentation from '@hcengineering/presentation'
  import { AccountRole, getCurrentAccount, Ref } from '@hcengineering/core'
  import { getCurrentEmployee } from '@hcengineering/contact'

  import love from '../plugin'
  import { getRoomName } from '../utils'
  import {
    infos,
    myOffice,
    currentRoom,
    meetings,
    myConnectingSessionId,
    aiBotPerson,
    connectingToMeeting
  } from '../stores'
  import { lkSessionConnected } from '../liveKitClient'
  import { createMeeting, joinMeeting } from '../meetings'
  import { get } from 'svelte/store'
  import RoomPreview from './RoomPreview.svelte'
  import { cancelInvites, sendKnockRequest, outgoingInvitesStore } from '../invites'

  export let object: Room
  export let readonly: boolean = false

  const dispatch = createEventDispatcher()

  let roomName: string
  $: void getRoomName(object).then((name) => {
    roomName = name
  })

  let connecting = false

  onMount(() => {
    dispatch('open', { ignoreKeys: ['name'] })
  })

  // The store holds everything but Finished, unordered, so a plain find could pick next week's
  // Scheduled meeting. Live ones win; a Scheduled one only inside its start window.
  function pickRoomMeeting (roomId: Ref<Room>, all: MeetingMinutes[]): MeetingMinutes | undefined {
    const ofRoom = all.filter((it) => it.roomId === roomId)
    return (
      ofRoom.find((it) => it.status === MeetingStatus.Active) ??
      ofRoom.find((it) => it.status === MeetingStatus.Pending) ??
      ofRoom.find((it) => isScheduledJoinable(it))
    )
  }

  async function connect (): Promise<void> {
    if ($connectingToMeeting) return
    const mm = pickRoomMeeting(object._id, get(meetings))
    if (mm !== undefined) {
      await joinMeeting(mm)
      return
    }
    const outcome = await createMeeting(object)
    // Someone is inside a meeting we cannot see - knocking is the only way in.
    if ('refused' in outcome && outcome.refused === 'room-occupied') {
      await knock()
    }
  }

  let connectLabel: IntlString | undefined

  async function updateConnecting (object: Room, infos: ParticipantInfo[], isLocalConnecting: boolean): Promise<void> {
    connecting = isLocalConnecting || ($currentRoom?._id === object._id && !$lkSessionConnected)

    let _connectLabel: IntlString = infos.some(({ room }) => room === object._id)
      ? love.string.JoinMeeting
      : love.string.StartMeeting

    if (infos.some(({ room }) => room === object._id) && !connecting) {
      _connectLabel = love.string.JoinMeeting
    } else if (!connecting) {
      _connectLabel = love.string.StartMeeting
    }
    connectLabel = _connectLabel
  }

  // Check if pending join is for THIS session (same browser tab)
  $: currentSessionId = getMetadata(presentation.metadata.SessionId)
  $: hasPendingJoinInThisSession = $myConnectingSessionId !== null && $myConnectingSessionId === currentSessionId

  $: void updateConnecting(object, $infos, hasPendingJoinInThisSession || $connectingToMeeting)

  function showConnectionButton (
    object: Room,
    connecting: boolean,
    isConnected: boolean,
    info: ParticipantInfo[],
    myOffice?: Room,
    currentRoom?: Room
  ): boolean {
    if (isOffice(object)) {
      // Do not show connect button in own office
      if (object._id === myOffice?._id) return false
      // Do not show connect for empty office
      if (object.person === null) return false

      const owner = object.person
      const ownerInfo = info.find((p) => p.person === owner)
      // Do not show connect if owner is not in the office
      if (ownerInfo?.room !== object._id) return false
    }

    // Show during connecting with spinner
    if (connecting) return true
    // Do not show connect button if we are already connected to the room
    if (isConnected && currentRoom?._id === object._id) return false

    return true
  }
  function getInfo (room: Ref<Room>, info: ParticipantInfo[]): ParticipantInfo[] {
    return info.filter((p) => p.room === room)
  }

  $: roomInfos = getInfo(object._id, $infos)

  const me = getCurrentEmployee()
  // Room is locked if participants are present but meeting is not in our accessible meetings store
  $: isLockedByPrivateMeeting =
    roomInfos.length > 0 &&
    !roomInfos.some((p) => p.person === me) &&
    !$meetings.some((m) => m.roomId === object._id && m.status !== MeetingStatus.Finished) &&
    getCurrentAccount().role !== AccountRole.Owner

  // Track whether we already sent a knock-request for this room. Knock
  // requests are tied to the room, not a specific recipient — the server
  // fans them out to the meeting's owners.
  $: knockTarget = roomInfos.find((p) => p.kind !== 'agent' && p.person !== $aiBotPerson)?.person
  $: pendingKnock = $outgoingInvitesStore.find((it) => it.from === me && it.room === object._id)
  $: hasOutgoingKnock = pendingKnock !== undefined

  async function knock (): Promise<void> {
    await sendKnockRequest(object._id)
  }

  async function cancelKnock (): Promise<void> {
    if (pendingKnock === undefined) return
    await cancelInvites(undefined, [pendingKnock])
  }
</script>

<!-- data-id: the MeetingMinutes page carries its own `meeting-connect`, so tests need to say which
     Connect they mean - the one on the floor's room panel is this one. -->
<div class="flex flex-col" data-id="room-panel">
  <div class="flex flex-row">
    <div class="flex flex-grow space-between gap-2 mb-4">
      <div class="name">
        <EditBox disabled={true} placeholder={love.string.Room} bind:value={roomName} focusIndex={1} />
      </div>

      {#if !isLockedByPrivateMeeting && showConnectionButton(object, connecting, $lkSessionConnected, $infos, $myOffice, $currentRoom) && connectLabel != null}
        <div data-id="meeting-connect">
          <ModernButton label={connectLabel} size="large" kind={'primary'} on:click={connect} loading={connecting} />
        </div>
      {:else if isLockedByPrivateMeeting && knockTarget !== undefined && !hasOutgoingKnock}
        <div data-id="meeting-knock">
          <ModernButton
            label={love.string.KnockAction}
            size="large"
            kind={'primary'}
            on:click={() => {
              void knock()
            }}
          />
        </div>
      {:else if isLockedByPrivateMeeting && hasOutgoingKnock}
        <div data-id="meeting-knock-pending">
          <ModernButton
            label={love.string.CancelKnock}
            size="large"
            kind={'secondary'}
            on:click={() => {
              void cancelKnock()
            }}
          />
        </div>
      {/if}
    </div>
  </div>
  {#if object != null && roomInfos.length > 0}
    <div class="room-preview">
      <RoomPreview room={object} info={roomInfos} preview />
    </div>
  {/if}
</div>

<style lang="scss">
  .name {
    font-weight: 500;
    font-size: 1.25rem;
    color: var(--theme-caption-color);
    width: 100%;
  }

  .room-preview {
    /* width: 100%; */
    height: 200px;
    max-width: 500px;
    overflow: hidden;
    padding: 2rem;
  }

  .step-tb-6 {
    margin-top: 1.5rem;
    margin-bottom: 1.5rem;
  }
</style>
