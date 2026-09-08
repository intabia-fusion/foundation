<!--
// Copyright © 2026 Intabia Fusion.
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
  import { WithLookup } from '@hcengineering/core'
  import { MeetingStatus, Room, RoomType, isOffice } from '@hcengineering/love'
  import { Icon, Label } from '@hcengineering/ui'
  import { DocNavLink } from '@hcengineering/view-resources'

  import love from '../plugin'
  import { infos, meetings } from '../stores'
  import { getRoomName } from '../utils'

  export let value: WithLookup<Room>

  let roomName: string = ''
  $: void getRoomName(value).then((name) => {
    roomName = name
  })

  $: memberCount = $infos.filter((p) => p.room === value._id).length

  $: hasActiveMeeting = $meetings.some((m) => m.roomId === value._id && m.status === MeetingStatus.Active)

  function getRoomTypeLabel (room: Room): string {
    if (isOffice(room)) return 'Office'
    switch (room.type) {
      case RoomType.Video:
        return 'Video'
      case RoomType.Audio:
        return 'Audio'
      case RoomType.Reception:
        return 'Reception'
      case RoomType.Scheduled:
        return 'Scheduled'
      default:
        return 'Room'
    }
  }
</script>

{#if value}
  <DocNavLink object={value}>
    <div class="room-table-presenter flex-row-center flex-gap-2">
      <div class="icon flex-no-shrink">
        <Icon icon={love.icon.Love} size={'small'} />
      </div>
      <div class="flex-col flex-grow min-w-0">
        <span class="label overflow-label">{roomName}</span>
        <span class="type-badge caption-color">{getRoomTypeLabel(value)}</span>
      </div>
      {#if memberCount > 0}
        <div class="members-badge flex-no-shrink" class:active={hasActiveMeeting}>
          <span>{memberCount}</span>
        </div>
      {/if}
      {#if hasActiveMeeting}
        <div class="active-indicator flex-no-shrink">
          <Label label={love.string.Active} />
        </div>
      {/if}
    </div>
  </DocNavLink>
{/if}

<style lang="scss">
  .room-table-presenter {
    min-width: 0;
    padding: 0.25rem 0;
  }

  .icon {
    color: var(--theme-caption-color);
  }

  .label {
    font-size: 0.875rem;
    color: var(--theme-caption-color);
  }

  .type-badge {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }

  .members-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.25rem;
    border-radius: 0.625rem;
    background: var(--theme-button-default);
    font-size: 0.75rem;
    color: var(--theme-caption-color);

    &.active {
      background: var(--bg-positive-default);
      color: white;
    }
  }

  .active-indicator {
    font-size: 0.75rem;
    color: var(--bg-positive-default);
  }
</style>
