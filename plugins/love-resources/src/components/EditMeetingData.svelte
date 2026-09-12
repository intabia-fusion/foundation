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
  import { Event, ReccuringInstance } from '@hcengineering/calendar'
  import { getCurrentAccount } from '@hcengineering/core'
  import love from '../plugin'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { ObjectPresenter } from '@hcengineering/view-resources'
  import { LIVE_MEETING_STATUSES, MeetingMinutes } from '@hcengineering/love'
  import { Button, ButtonIcon, Icon, IconSettings, Label, eventToHTMLElement, showPopup } from '@hcengineering/ui'
  import MeetingMinutesStatusPresenter from './MeetingMinutesStatusPresenter.svelte'
  import { joinMeeting, joinScheduledMeeting, leaveMeeting } from '../meetings'
  import MeetingLinkPopup from './MeetingLinkPopup.svelte'

  export let value: Event
  export let readOnly: boolean = false

  const valueQuery = createQuery()
  const meetingQuery = createQuery()
  const currentAccount = getCurrentAccount()

  let _value: Event = value

  $: valueQuery.query(value._class, { _id: value._id }, (r) => {
    _value = r.shift() ?? value
  })
  const client = getClient()

  $: isMeeting = client.getHierarchy().hasMixin(_value, love.mixin.MeetingEventLink)
  $: meeting = isMeeting ? client.getHierarchy().as(_value, love.mixin.MeetingEventLink) : null

  let meetingDoc: MeetingMinutes | undefined

  // An expanded occurrence is virtual: `getInstance` gives it a brand new eventId that exists in
  // no database. Everything about the meeting hangs off the series, so resolve that instead.
  $: seriesEventId = (_value as ReccuringInstance).recurringEventId ?? _value.eventId

  // A session exists only while the meeting is running - it is looked up by the series, not by a
  // reference on the event, which no longer holds one.
  $: meetingQuery.query(
    love.class.MeetingMinutes,
    { eventId: seriesEventId, status: { $in: LIVE_MEETING_STATUSES } },
    (r) => {
      meetingDoc = r.shift()
    }
  )

  async function openMeeting (): Promise<void> {
    // Sessions of a series are opened by the love service, addressed by the event. The old path
    // stays for meetings whose mixin still points at a session created by the client (F1 §7).
    if (seriesEventId !== undefined && meeting?.linkVersion !== undefined) {
      await joinScheduledMeeting(seriesEventId)
      return
    }
    if (meetingDoc === undefined) return
    await joinMeeting(meetingDoc)
  }

  async function closeMeeting (): Promise<void> {
    await leaveMeeting()
  }
</script>

{#if isMeeting}
  <div class="flex-col mt-2">
    <div class="flex-row-center">
      <div class="mr-2">
        <Icon icon={love.icon.MeetingMinutes} size={'small'} />
      </div>
      <div class="mr-2">
        <Label label={love.string.Meeting} />
      </div>
      <div class="flex-grow">
        {#if meetingDoc !== undefined}
          <ObjectPresenter
            shouldShowAvatar={false}
            objectId={meetingDoc._id}
            _class={meetingDoc._class}
            value={meetingDoc}
          />
        {/if}
      </div>
      <div class="ml-3 flex flex-row-center flex-gap-2">
        {#if meetingDoc !== undefined}
          <MeetingMinutesStatusPresenter object={meetingDoc} value={meetingDoc.status} attributeKey={'status'} />
        {/if}
        {#if !readOnly}
          <ButtonIcon
            icon={IconSettings}
            size={'small'}
            kind={'tertiary'}
            tooltip={{ label: love.string.MeetingLinkSettings }}
            on:click={(e) => {
              showPopup(MeetingLinkPopup, { event: _value }, eventToHTMLElement(e))
            }}
          />
        {/if}
        <!-- Any participant may start a scheduled meeting, not only its owner. -->
        {#if meetingDoc !== undefined}
          <Button kind={'negative'} label={love.string.EndMeeting} size={'x-small'} on:click={closeMeeting} />
        {:else}
          <Button kind={'primary'} label={love.string.StartMeeting} size={'x-small'} on:click={openMeeting} />
        {/if}
      </div>
    </div>
  </div>
{/if}
