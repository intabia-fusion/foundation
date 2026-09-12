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
  import { Person } from '@hcengineering/contact'
  import { Avatar } from '@hcengineering/contact-resources'
  import { ModernButton } from '@hcengineering/ui'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { UserMeetingInvite } from '@hcengineering/love'
  import love from '../../../plugin'

  export let person: Person
  export let invite: UserMeetingInvite
  export let type: 'outgoing' | 'incoming'
  export let onClick: (e: MouseEvent, invite: UserMeetingInvite, person: Person) => void

  $: label =
    type === 'incoming'
      ? love.string.KnockingLabel
      : invite.room !== undefined
        ? love.string.KnockingTo
        : love.string.YouInvite

  $: tooltipLabel =
    type === 'outgoing'
      ? invite.room !== undefined
        ? getEmbeddedLabel(`Knocking to ${person.name}`)
        : getEmbeddedLabel(`Inviting ${person.name}`)
      : getEmbeddedLabel(`Invited by ${person.name}`)
</script>

<ModernButton
  {label}
  kind="primary"
  size="small"
  tooltip={{ label: tooltipLabel, direction: 'bottom' }}
  dataId={type === 'incoming' ? 'incoming-invite-trigger' : 'outgoing-invite-trigger'}
  on:click={(e) => {
    onClick(e, invite, person)
  }}
>
  <div class="avatars-container">
    <div class="combined-avatar tiny">
      <Avatar name={person.name} size={'card'} {person} />
    </div>
  </div>
</ModernButton>

<style lang="scss">
  .avatars-container {
    display: inline-flex;
    align-items: center;
    margin-left: 0.5rem;
  }

  .time {

    color: var(--accent-color-base);
  }

  .combined-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &.tiny {
      width: 1.5rem;
      height: 1.5rem;
    }

    &[data-over]::after {
      content: attr(data-over);
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      color: white;
      font-size: 0.625rem;
      font-weight: 600;
      border-radius: 50%;
    }
  }
</style>
