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
  import { Room, RoomType, isOffice } from '@hcengineering/love'
  import { Icon } from '@hcengineering/ui'
  import { DocNavLink } from '@hcengineering/view-resources'

  import love from '../plugin'
  import { infos } from '../stores'
  import { getRoomName } from '../utils'

  export let value: WithLookup<Room>

  let roomName: string = ''
  $: void getRoomName(value).then((name) => {
    roomName = name
  })

  $: memberCount = $infos.filter((p) => p.room === value._id).length

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
    <div class="room-list-item flex-row-center flex-gap-2">
      <div class="icon flex-no-shrink">
        <Icon icon={love.icon.Love} size={'small'} />
      </div>
      <span class="name overflow-label flex-grow">{roomName}</span>
      <span class="type flex-no-shrink">{getRoomTypeLabel(value)}</span>
      {#if memberCount > 0}
        <span class="count flex-no-shrink">{memberCount}</span>
      {/if}
    </div>
  </DocNavLink>
{/if}

<style lang="scss">
  .room-list-item {
    min-width: 0;
    padding: 0.25rem 0.5rem;

    &:hover {
      background: var(--theme-button-hovered);
      border-radius: 0.25rem;
    }
  }

  .icon {
    color: var(--theme-caption-color);
  }

  .name {
    font-size: 0.875rem;
    color: var(--theme-caption-color);
  }

  .type {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }

  .count {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--theme-caption-color);
    background: var(--theme-button-default);
    border-radius: 0.625rem;
    padding: 0 0.375rem;
    min-width: 1.25rem;
    text-align: center;
  }
</style>
