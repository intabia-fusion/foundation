<!--
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
-->
<!--
  The service floor of scheduled meetings. It holds no grid: a scheduled meeting occupies no
  place, so the floor is a calendar of what is coming plus a list of what is running right now.

  Rows are the viewer's own: the calendar shows the copies of events they take part in, so a
  common floor does not make the schedule common (F1 §10).
-->
<script lang="ts">
  import calendar from '@hcengineering/calendar'
  import { getCurrentAccount } from '@hcengineering/core'
  import love, { LIVE_MEETING_STATUSES, type MeetingMinutes, type PermanentMeeting } from '@hcengineering/love'
  import { createQuery } from '@hcengineering/presentation'
  import { ButtonIcon, Component, IconAdd, Label, Scroller, showPopup } from '@hcengineering/ui'
  import plugin from '../plugin'
  import CreatePermanentMeetingPopup from './CreatePermanentMeetingPopup.svelte'
  import MeetingMinutesPresenter from './MeetingMinutesPresenter.svelte'
  import PermanentMeetingCard from './PermanentMeetingCard.svelte'

  const me = getCurrentAccount()

  let live: MeetingMinutes[] = []
  const liveQuery = createQuery()
  // Sessions of scheduled meetings only - an ad-hoc one belongs to its own room, not here.
  $: liveQuery.query(
    love.class.MeetingMinutes,
    { roomId: love.ids.ScheduledRoom, status: { $in: LIVE_MEETING_STATUSES } },
    (res) => {
      live = res
    }
  )

  // A private session shows up for its members only; everyone else sees the busy badge the
  // ordinary floors already use.
  $: visible = live.filter((it) => !it.private || it.members.includes(me.uuid))

  // No filter: spaceSecurity already limits this to the meetings the account is a member of.
  let permanentMeetings: PermanentMeeting[] = []
  const permanentMeetingsQuery = createQuery()
  permanentMeetingsQuery.query(love.class.PermanentMeeting, {}, (res) => {
    permanentMeetings = res
  })

  function createPermanentMeeting (): void {
    showPopup(CreatePermanentMeetingPopup, {})
  }
</script>

<div class="flex-col h-full">
  {#if visible.length > 0}
    <div class="active-sessions flex-col flex-gap-2 p-4">
      <div class="fs-title"><Label label={plugin.string.ActiveMeetings} /></div>
      <Scroller>
        {#each visible as session (session._id)}
          <div class="session-row flex-row-center flex-gap-2 py-1">
            <MeetingMinutesPresenter value={session} />
          </div>
        {/each}
      </Scroller>
    </div>
  {/if}

  <div class="permanent-meetings flex-col flex-gap-2 p-4">
    <div class="flex-row-center flex-between">
      <div class="fs-title"><Label label={plugin.string.PermanentMeetings} /></div>
      <ButtonIcon icon={IconAdd} kind={'primary'} size={'small'} on:click={createPermanentMeeting} />
    </div>
    {#if permanentMeetings.length > 0}
      <Scroller>
        {#each permanentMeetings as meeting (meeting._id)}
          <PermanentMeetingCard value={meeting} />
        {/each}
      </Scroller>
    {:else}
      <span class="content-dark-color"><Label label={plugin.string.NoPermanentMeetings} /></span>
    {/if}
  </div>

  <div class="flex-grow min-h-0">
    <!-- Resolved by id rather than imported: love does not depend on calendar-resources. -->
    <Component
      is={calendar.component.CalendarView}
      props={{
        _class: calendar.class.Event,
        query: { [love.mixin.MeetingEventLink]: { $exists: true } }
      }}
    />
  </div>
</div>

<style lang="scss">
  .active-sessions {
    flex-shrink: 0;
    max-height: 12rem;
    border-bottom: 1px solid var(--theme-divider-color);
  }
  .session-row {
    min-width: 0;
  }
  .permanent-meetings {
    flex-shrink: 0;
    max-height: 16rem;
    border-bottom: 1px solid var(--theme-divider-color);
  }
</style>
