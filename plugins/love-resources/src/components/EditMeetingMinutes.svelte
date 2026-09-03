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
  import presentation, { createQuery, getClient } from '@hcengineering/presentation'
  import { EditBox, ModernButton } from '@hcengineering/ui'
  import { MeetingMinutes, MeetingStatus, PendingRecording, ParticipantInfo } from '@hcengineering/love'
  import { createEventDispatcher, onMount } from 'svelte'

  import love from '../plugin'
  import { joinMeeting, leaveMeeting } from '../meetings'
  import { currentMeetingMinutes, infos, myConnectingSessionId, rooms, connectingToMeeting } from '../stores'
  import { lkIsConnecting, lkSessionConnected } from '../liveKitClient'
  import { getMetadata } from '@hcengineering/platform'
  import { getCurrentAccount, Ref } from '@hcengineering/core'
  import ParticipantsPreview from './ParticipantsPreview.svelte'
  import PendingRecordingPresenter from './PendingRecordingPresenter.svelte'
  import { openWidgetTab } from '@hcengineering/workbench-resources'
  import { videoVisible } from '../utils'

  export let object: MeetingMinutes
  export let readonly: boolean = false

  const client = getClient()
  const dispatch = createEventDispatcher()

  const currentAccount = getCurrentAccount()

  let currentName = object.name
  let newName = object.name

  $: if (object.name !== currentName) {
    newName = object.name
    currentName = object.name
  }

  async function changeName (): Promise<void> {
    await client.diffUpdate(object, { name: newName })
  }

  async function togglePrivate (): Promise<void> {
    await client.diffUpdate(object, { private: !object.private })
  }

  // Check if current user is owner of the meeting
  $: isOwner = object.owners?.includes(currentAccount.uuid) ?? false

  onMount(() => {
    dispatch('open', { ignoreKeys: ['name'] })
  })

  // Check if pending join is for THIS session (same browser tab)
  $: currentSessionId = getMetadata(presentation.metadata.SessionId)
  $: hasPendingJoinInThisSession =
    $myConnectingSessionId !== null && $myConnectingSessionId === currentSessionId && $lkIsConnecting

  async function connect (): Promise<void> {
    if ($connectingToMeeting) return
    await joinMeeting(object)
  }

  $: connectLabel = object.status !== MeetingStatus.Scheduled ? love.string.JoinMeeting : love.string.StartMeeting

  function showConnectionButton (object: MeetingMinutes, connecting: boolean, isConnected: boolean): boolean {
    if (object.status === MeetingStatus.Finished) {
      return false
    }
    // Show during connecting with spinner
    if (connecting) return true
    // Do not show connect button if we are already connected to the room
    if (isConnected && $currentMeetingMinutes?._id === object._id) return false

    return true
  }

  function getInfo (mm: Ref<MeetingMinutes>, info: ParticipantInfo[]): ParticipantInfo[] {
    return info.filter((p) => p.meeting === mm)
  }

  $: roomInfos = getInfo(object._id, $infos)

  $: room = $rooms.find((it) => it._id === object.roomId)

  const pendingQuery = createQuery()
  let pendingRecordings: PendingRecording[] = []

  $: pendingQuery.query(love.class.PendingRecording, { attachedTo: object._id }, (result) => {
    pendingRecordings = result
  })
</script>

<div class="flex flex-col">
  <div class="flex flex-row">
    <div class="flex flex-grow flex-between gap-2 mb-4">
      <div class="title flex-grow" data-id="meeting-name-input">
        <EditBox
          disabled={readonly}
          placeholder={love.string.MeetingMinutes}
          bind:value={newName}
          on:change={changeName}
          focusIndex={1}
        />
      </div>
      {#if isOwner}
        <ModernButton
          label={object.private ? love.string.OpenRoom : love.string.CloseRoom}
          size="large"
          kind={object.private ? 'secondary' : 'primary'}
          on:click={togglePrivate}
          dataId={'meeting-toggle-private'}
        />
      {/if}
      {#if showConnectionButton(object, hasPendingJoinInThisSession || $connectingToMeeting, $lkSessionConnected)}
        <ModernButton
          label={connectLabel}
          size="large"
          kind={'primary'}
          on:click={connect}
          loading={hasPendingJoinInThisSession || $connectingToMeeting}
          dataId={'meeting-connect'}
        />
      {:else if $lkSessionConnected}
        {#if !$videoVisible}
          <ModernButton
            label={love.string.ShowVideo}
            size="large"
            kind={'secondary'}
            on:click={() => {
              openWidgetTab(love.ids.MeetingWidget, 'video')
            }}
          />
        {/if}
        <ModernButton
          label={love.string.LeaveRoom}
          size="large"
          kind={'negative'}
          on:click={() => {
            void leaveMeeting()
          }}
          dataId={'meeting-leave'}
        />
      {/if}
    </div>
  </div>
  {#if object != null && roomInfos.length > 0 && room != null}
    <div class="room-preview">
      <ParticipantsPreview info={roomInfos} />
    </div>
  {/if}
  {#if pendingRecordings.length > 0}
    <div class="pending-recordings">
      {#each pendingRecordings as recording}
        <PendingRecordingPresenter value={recording} />
      {/each}
    </div>
  {/if}
</div>

<style lang="scss">
  .title {
    font-weight: 500;
    font-size: 1.25rem;
    color: var(--theme-caption-color);
  }
  .room-preview {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .pending-recordings {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
</style>
