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
  import { AccountArrayEditor } from '@hcengineering/contact-resources'
  import core, { SortingOrder, type AccountUuid } from '@hcengineering/core'
  import love, { LIVE_MEETING_STATUSES, type MeetingMinutes, type PermanentMeeting } from '@hcengineering/love'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { Button, ButtonIcon, IconSettings, Label, eventToHTMLElement, showPopup } from '@hcengineering/ui'
  import { joinPermanentMeeting } from '../meetings'
  import { DocNavLink } from '@hcengineering/view-resources'
  import MeetingLinkPopup from './MeetingLinkPopup.svelte'
  import MeetingMinutesPresenter from './MeetingMinutesPresenter.svelte'

  export let value: PermanentMeeting

  const client = getClient()

  // An owner off the member list loses the space they own, so they always stay on it.
  async function membersChanged (members: AccountUuid[]): Promise<void> {
    const owners = value.owners ?? []
    const kept = [...new Set([...members, ...owners])]
    await client.update(value, { members: kept })
  }

  let sessions: MeetingMinutes[] = []
  const sessionsQuery = createQuery()
  $: sessionsQuery.query(
    love.class.MeetingMinutes,
    // The running session belongs above, in "Happening now" - listing it as past is a lie.
    { meeting: value._id, status: { $nin: LIVE_MEETING_STATUSES } },
    (res) => {
      sessions = res
    },
    { sort: { meetingEnd: SortingOrder.Descending } }
  )
</script>

<div class="permanent-meeting flex-col flex-gap-1 p-2">
  <div class="flex-row-center flex-gap-2">
    <div class="flex-grow min-w-0">
      <DocNavLink object={value}>
        <span class="name overflow-label">{value.name}</span>
      </DocNavLink>
    </div>
    <AccountArrayEditor
      value={value.members}
      label={core.string.Members}
      onChange={(members) => {
        void membersChanged(members)
      }}
      kind={'link'}
      size={'small'}
    />
    <ButtonIcon
      icon={IconSettings}
      size={'small'}
      kind={'tertiary'}
      tooltip={{ label: love.string.MeetingLinkSettings }}
      on:click={(e) => {
        showPopup(MeetingLinkPopup, { meeting: value }, eventToHTMLElement(e))
      }}
    />
    <Button
      label={love.string.JoinMeeting}
      kind={'primary'}
      size={'small'}
      on:click={() => {
        void joinPermanentMeeting(value._id)
      }}
    />
  </div>
  {#if sessions.length > 0}
    <div class="flex-col flex-gap-1 pl-2">
      <span class="past-sessions-label"><Label label={love.string.PastSessions} /></span>
      {#each sessions as session (session._id)}
        <MeetingMinutesPresenter value={session} />
      {/each}
    </div>
  {/if}
</div>

<style lang="scss">
  .permanent-meeting {
    min-width: 0;
    padding: 0.5rem;
    border-radius: 0.25rem;

    &:hover {
      background: var(--theme-button-hovered);
    }
  }

  .name {
    font-size: 0.875rem;
    color: var(--theme-caption-color);
  }

  .past-sessions-label {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
</style>
