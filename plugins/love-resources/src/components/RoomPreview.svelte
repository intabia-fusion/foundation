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
  import { getCurrentEmployee, Person } from '@hcengineering/contact'
  import { Avatar, myEmployeeStore, getPersonByPersonRef, statusByUserStore } from '@hcengineering/contact-resources'
  import { MeetingMinutes, ParticipantInfo, Room, RoomType, MeetingStatus, isOffice, Office } from '@hcengineering/love'
  import { Icon, Label, eventToHTMLElement, showPopup } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import { getClient } from '@hcengineering/presentation'
  import { openDoc } from '@hcengineering/view-resources'

  import love from '../plugin'
  import {
    myInfo,
    myOffice,
    selectedRoomPlace,
    currentRoom,
    currentMeetingMinutes,
    infos,
    meetings,
    busyPersons
  } from '../stores'
  import { getRoomLabel } from '../utils'
  import { IntlString } from '@hcengineering/platform'
  import { lkSessionConnected } from '../liveKitClient'
  import { AccountUuid, clone, getCurrentAccount, Ref } from '@hcengineering/core'
  // import RoomLanguage from './RoomLanguage.svelte'
  import PersonActionPopup from './PersonActionPopup.svelte'

  export let room: Room
  export let info: ParticipantInfo[]
  export let preview: boolean = false
  export let hovered: boolean = false

  const dispatch = createEventDispatcher()

  function prepareInfo (info: ParticipantInfo[]): ParticipantInfo[] {
    const result: ParticipantInfo[] = []
    const posMap = new Set<string>()

    const conflicts: ParticipantInfo[] = []
    for (const r of info) {
      if (posMap.has(`${r.x}.${r.y}`)) {
        conflicts.push(r)
      } else {
        posMap.add(`${r.x}.${r.y}`)
        result.push(r)
      }
    }
    for (const c of conflicts) {
      let found = false
      for (let y = 0; y < room.height; y++) {
        for (let x = 0; x < room.width; x++) {
          if (!posMap.has(`${x}.${y}`)) {
            const nc = clone(c)
            nc.x = x
            nc.y = y
            posMap.add(`${x}.${y}`)
            result.push(nc)
            found = true
            break
          }
        }
        if (found) break
      }
      if (!found) {
        // Grid is full - overflow along x, extra columns still render them.
        let x = room.width
        while (posMap.has(`${x}.0`)) x++
        const nc = clone(c)
        nc.x = x
        nc.y = 0
        posMap.add(`${x}.0`)
        result.push(nc)
      }
    }

    return result
  }

  // prepareInfo resolves collisions per client, so browsers paint different layouts.
  // The meeting creator writes its layout back; notMatch keeps it off a taken cell.
  const persistedPlaces = new Set<string>()

  async function persistPlaces (
    resolved: ParticipantInfo[],
    original: ParticipantInfo[],
    allMeetings: MeetingMinutes[]
  ): Promise<void> {
    if (preview) return
    const myIds = getCurrentAccount().socialIds
    const client = getClient()

    for (const r of resolved) {
      const src = original.find((p) => p._id === r._id)
      if (src === undefined || (src.x === r.x && src.y === r.y)) continue
      // Overflow cells are outside the grid - the server picks those too.
      if (r.x >= room.width || r.y >= room.height) continue
      if (r.meeting == null) continue

      const meeting = allMeetings.find((it) => it._id === r.meeting)
      if (meeting?.createdBy == null || !myIds.includes(meeting.createdBy)) continue

      const key = `${r._id}.${r.x}.${r.y}`
      if (persistedPlaces.has(key)) continue
      persistedPlaces.add(key)

      const ops = client.apply(`love_place_${r._id}`)
      ops.notMatch(love.class.ParticipantInfo, { room: room._id, x: r.x, y: r.y })
      await ops.update(src, { x: r.x, y: r.y })
      await ops.commit()
    }
  }

  $: _info = prepareInfo(info ?? [])
  $: persistPlaces(_info, info ?? [], $meetings).catch((err) => {
    console.error('[RoomPreview] failed to persist places', err)
  })

  const me = getCurrentEmployee()
  $: myName = $myEmployeeStore?.name

  let hoveredRoomX: number | undefined = undefined
  let hoveredRoomY: number | undefined = undefined

  let roomLabel: IntlString
  $: {
    void getRoomLabel(room).then((label) => {
      roomLabel = label
    })
  }

  // Room is locked if participants are present but meeting is not in our accessible meetings store
  // (private meeting we don't have access to)
  $: isLockedByPrivateMeeting =
    info.length > 0 &&
    !info.some((p) => p.person === me) &&
    !$meetings.some((m) => m.roomId === room._id && m.status !== MeetingStatus.Finished)

  $: disabled = room._class === love.class.Office && _info.length === 0

  let personPopupVisible: Ref<Person> | undefined = undefined

  async function getPerson (info: Ref<Person> | undefined): Promise<Person | undefined> {
    if (info === undefined) {
      return
    }

    return (await getPersonByPersonRef(info)) ?? undefined
  }

  function getPersonInfo (y: number, x: number, info: ParticipantInfo[]): Omit<ParticipantInfo, 'meeting'> | undefined {
    return info.find((p) => p.x === x && p.y === y)
  }

  function mouseEnter (): void {
    hovered = true
    dispatch('hover', { name: roomLabel })
  }

  function mouseLeave (): void {
    hovered = false
  }

  async function openRoom (x: number, y: number): Promise<void> {
    const client = getClient()
    const hierarchy = client.getHierarchy()
    if ($lkSessionConnected && $currentRoom?._id === room._id) {
      let meeting = $currentMeetingMinutes
      if (meeting?.roomId !== room._id || meeting?.status !== MeetingStatus.Active) {
        meeting = await client.findOne(love.class.MeetingMinutes, {
          roomId: room._id,
          status: MeetingStatus.Active
        })
      }
      if (meeting === undefined) {
        await openDoc(hierarchy, room)
      } else {
        // We have active meeting, let's connect to it.
        await openDoc(hierarchy, meeting)
      }
    } else {
      selectedRoomPlace.set({ _id: room._id, x, y })
      await openDoc(hierarchy, room)
    }
  }

  async function placeClickHandler (e: MouseEvent, x: number, y: number): Promise<void> {
    e.stopPropagation()
    e.preventDefault()

    // Get person at this position
    const personInfo = getPersonInfo(y, x, _info)
    if (personInfo !== undefined) {
      const person = await getPerson(personInfo.person)
      if (person !== undefined) {
        if ($myInfo === undefined || (person._id === me && $myInfo?.room === room._id)) return
        personPopupVisible = person._id
        showPopup(PersonActionPopup, { room, person: person._id }, eventToHTMLElement(e), () => {
          personPopupVisible = undefined
        })
        return
      }
    }

    // Check if clicking on room owner avatar (shown in office at position 0,0)
    if (isOffice(room) && x === 0 && y === 0 && shouldShowAvatar && roomPerson != null) {
      const isMe = roomPerson._id === me && $myInfo?.room === room._id
      if (isMe) {
        await openRoom(x, y)
        return
      }
      personPopupVisible = roomPerson._id
      showPopup(PersonActionPopup, { room, person: roomPerson._id }, eventToHTMLElement(e), () => {
        personPopupVisible = undefined
      })
      return
    }

    await openRoom(x, y)
  }

  $: extraRow = calcExtraRows(hovered, room, _info, $myInfo)
  // Footprint grows only on hover; otherwise overflow columns squeeze inside the
  // room box - widening it permanently would overlap the neighbouring room.
  $: spanWidth = hovered ? room.width + extraRow : room.width

  function calcExtraRows (
    hovered: boolean,
    room: Room,
    info: ParticipantInfo[],
    myInfo: ParticipantInfo | undefined
  ): number {
    let maxX = info.reduce((acc, p) => {
      acc = Math.max(acc, p.x)
      return acc
    }, 0)
    maxX++
    let init = maxX > room.width ? maxX - room.width : 0
    // Overflow columns must render unhovered too, else those participants are invisible.
    if (!hovered) return init

    for (let y = 0; y < room.height; y++) {
      for (let x = 0; x < room.width; x++) {
        if (info.find((p) => p.x === x && p.y === y) === undefined) {
          return init
        }
      }
    }
    if (myInfo?.room !== room._id) {
      init++
      while (init < 5) {
        const x = room.width + init
        for (let y = 0; y < room.height; y++) {
          if (info.find((p) => p.x === x && p.y === y) === undefined) {
            return init
          }
        }
        init++
      }
    }
    return init
  }

  async function handleClick (): Promise<void> {
    await openRoom(0, 0)
  }

  // Create a store for the office person that reacts to room.person changes
  let roomPerson: Person | null

  $: if (isOffice(room) && room.person != null) {
    void getPersonByPersonRef(room.person).then((res) => {
      roomPerson = res
    })
  } else {
    roomPerson = null
  }

  // Check if this is the user's current room (where they are in ParticipantInfo)
  $: isUserInOtherRoom = $infos.some((it) => it.person === roomPerson?._id && it.room !== room._id)

  // Show avatar for office owner if:
  // 1. It's an office AND
  // 2. There's a person assigned to it
  $: shouldShowAvatar = isOffice(room) && room.person != null

  // Check if user is online (for styling)
  $: isUserOnline =
    roomPerson?.personUuid != null
      ? ($statusByUserStore.get(roomPerson.personUuid as AccountUuid)?.online ?? false)
      : false
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- svelte-ignore a11y-mouse-events-have-key-events -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<div
  class="floorGrid-room"
  data-id={`room-${room.name}`}
  class:hovered
  class:disabled
  class:myOffice={$myOffice?._id === room._id}
  style:--huly-floor-roomWidth={room.width + extraRow}
  style:--huly-floor-roomHeight={room.height}
  style:grid-column={`${room.x + 2} / span ${spanWidth}`}
  style:grid-row={`${room.y + 2} / span ${room.height}`}
  style:grid-template-columns={`repeat(${room.width + extraRow}, 1fr)`}
  style:grid-template-rows={`repeat(${room.height}, 1fr)`}
  style:aspect-ratio={`${spanWidth} / ${room.height}`}
  on:mouseover|stopPropagation
  on:mouseenter|stopPropagation={mouseEnter}
  on:mouseleave|stopPropagation={mouseLeave}
  on:click|stopPropagation={handleClick}
>
  {#each new Array(room.height) as _, y}
    {#each new Array(room.width + extraRow) as _, x}
      {@const personInfo = getPersonInfo(y, x, _info)}
      {@const isHovered = hoveredRoomX === x && hoveredRoomY === y}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="floorGrid-room__field"
        class:hovered={isHovered}
        class:person={$myInfo?.room === room._id}
        on:mouseenter={() => {
          if ($myInfo?.room !== room._id) {
            hoveredRoomX = x
            hoveredRoomY = y
          }
        }}
        on:mouseout={() => {
          hoveredRoomX = undefined
          hoveredRoomY = undefined
        }}
        on:click={(e) => {
          placeClickHandler(e, x, y).catch(() => {
            // Ignore errors
          })
        }}
      >
        {#if personInfo === undefined && shouldShowAvatar && !isUserInOtherRoom && roomPerson != null && x === 0 && y === 0}
          {#if isHovered || isUserOnline || personPopupVisible === roomPerson?._id}
            <Avatar name={roomPerson.name} person={roomPerson} size={'large'} variant={'roundedRect'} adaptiveName />
          {/if}
        {:else if personInfo !== undefined}
          {@const isBusy = $busyPersons.has(personInfo.person)}
          {#await getPerson(personInfo.person) then person}
            {#if personInfo}
              <div class="relative">
                <Avatar
                  name={person?.name ?? personInfo.name}
                  {person}
                  size={'large'}
                  showStatus={false}
                  adaptiveName
                />
                {#if isBusy}
                  <div class="busy-badge" data-id="busy-badge">
                    <Label label={love.string.Busy} />
                  </div>
                {/if}
              </div>
            {:else if hoveredRoomX === x && hoveredRoomY === y}
              <Avatar name={myName} person={$myEmployeeStore} size={'large'} showStatus={false} adaptiveName />
            {/if}
          {/await}
        {/if}
      </div>
    {/each}
  {/each}

  {#if !preview}
    <div class="floorGrid-room__header">
      <span class="overflow-label text-md flex-grow">
        <Label label={roomLabel} />
      </span>
      <!-- {#if !isOffice(room)}
        <RoomLanguage {room} />
      {/if} -->
      {#if !isOffice(room) && (room.type === RoomType.Video || room.startPrivate || isLockedByPrivateMeeting)}
        <div class="flex-row-center flex-no-shrink h-full flex-gap-2">
          {#if isLockedByPrivateMeeting || room.startPrivate}
            <Icon
              icon={love.icon.DND}
              fill={isLockedByPrivateMeeting ? 'var(--bg-negative-default)' : 'var(--theme-caption-color)'}
              size={'small'}
            />
          {/if}
          {#if room.type === RoomType.Video}
            <Icon icon={love.icon.CamEnabled} size={'small'} />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .relative {
    position: relative;
  }

  .busy-badge {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-size: 0.65rem;
    padding: 1px 2px;
    text-align: center;
    border-radius: 0 0 4px 4px;
    pointer-events: none;
  }
</style>
