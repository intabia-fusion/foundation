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
<script lang="ts">
  import calendar, { type Event } from '@hcengineering/calendar'
  import { copyTextToClipboard, getClient } from '@hcengineering/presentation'
  import love, {
    defaultMeetingAccess,
    meetingMasterQuery,
    type MeetingAccess,
    type PermanentMeeting
  } from '@hcengineering/love'
  import { Button, DropdownLabelsIntl, EditBox, Label, type DropdownIntlItem } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import plugin from '../plugin'
  import { getEventMeetingLink, revokeMeetingLink, revokePermanentMeetingLink } from '../utils'
  import { getLoveClient } from '../loveClient'

  // Exactly one of the two: a calendar series keeps its policy in a mixin, a permanent meeting
  // on the document itself.
  export let event: Event | undefined = undefined
  export let meeting: PermanentMeeting | undefined = undefined

  const client = getClient()
  const loveClient = getLoveClient()
  const dispatch = createEventDispatcher()

  const DAY = 24 * 60 * 60 * 1000

  const startItems: DropdownIntlItem[] = [
    { id: 'members', label: plugin.string.StartMembersOnly },
    { id: 'link', label: plugin.string.StartAnyoneWithLink }
  ]
  const pastItems: DropdownIntlItem[] = [
    { id: 'last', label: plugin.string.PastLast },
    { id: 'none', label: plugin.string.PastNone }
  ]
  // Days rather than a free-form duration: the value only decides how long a dead series stays
  // reachable, and an exact figure there means nothing to anyone.
  const ttlItems: DropdownIntlItem[] = [
    { id: `${DAY}`, label: plugin.string.Day },
    { id: `${7 * DAY}`, label: plugin.string.Week },
    { id: `${30 * DAY}`, label: plugin.string.Month }
  ]

  let master: Event | undefined
  let access: MeetingAccess = defaultMeetingAccess

  // A permanent meeting has no series to outlive, so `past` and `afterTtl` decide nothing there.
  $: isPermanent = meeting !== undefined
  $: pointer = meeting !== undefined ? meeting._id : master?.eventId

  // Kept only in this popup's memory after a successful save, to power "copy link + password" -
  // the server never returns the plaintext, so a freshly reopened popup has nothing to copy.
  let plainPassword: string | undefined
  let editingPassword = false
  let passwordInput = ''

  $: if (meeting !== undefined) {
    access = meeting.meetingAccess ?? defaultMeetingAccess
  } else if (event !== undefined) {
    void client.findOne(calendar.class.Event, meetingMasterQuery(event)).then((res) => {
      master = res
      if (res !== undefined) {
        access = client.getHierarchy().as(res, love.mixin.MeetingEventLink).meetingAccess ?? defaultMeetingAccess
      }
    })
  }

  async function save (update: Partial<MeetingAccess>): Promise<void> {
    access = { ...access, ...update }
    if (meeting !== undefined) {
      await client.update(meeting, { meetingAccess: access })
      return
    }
    if (master === undefined) return
    await client.updateMixin(master._id, master._class, master.space, love.mixin.MeetingEventLink, {
      meetingAccess: access
    })
  }

  function startEditPassword (): void {
    passwordInput = ''
    editingPassword = true
  }

  async function savePassword (): Promise<void> {
    if (pointer === undefined || passwordInput === '') return
    await loveClient.setGuestPassword(pointer, passwordInput, isPermanent ? 'meeting' : 'event')
    plainPassword = passwordInput
    access = { ...access, guestPassword: { hash: '', salt: '' } }
    editingPassword = false
  }

  async function removePassword (): Promise<void> {
    if (pointer === undefined) return
    await loveClient.setGuestPassword(pointer, null, isPermanent ? 'meeting' : 'event')
    plainPassword = undefined
    access = { ...access, guestPassword: undefined }
  }

  async function copyLinkWithPassword (): Promise<void> {
    if (pointer === undefined || plainPassword === undefined) return
    const link = await getEventMeetingLink(pointer, isPermanent ? 'meeting' : 'event')
    await copyTextToClipboard(`${link}\n${plainPassword}`)
  }

  async function revoke (): Promise<void> {
    if (meeting !== undefined) {
      await revokePermanentMeetingLink(meeting)
    } else if (event !== undefined) {
      await revokeMeetingLink(event)
    }
    dispatch('close')
  }
</script>

<div class="antiPopup p-4 flex-col flex-gap-3">
  <div class="fs-title"><Label label={plugin.string.MeetingLinkSettings} /></div>

  <div class="grid">
    <Label label={plugin.string.WhoCanStart} />
    <DropdownLabelsIntl
      items={startItems}
      selected={access.start}
      kind={'regular'}
      size={'medium'}
      on:selected={(e) => {
        void save({ start: e.detail })
      }}
    />

    {#if !isPermanent}
      <Label label={plugin.string.AfterTheSeries} />
      <DropdownLabelsIntl
        items={pastItems}
        selected={access.past}
        kind={'regular'}
        size={'medium'}
        on:selected={(e) => {
          void save({ past: e.detail })
        }}
      />

      <Label label={plugin.string.LinkLifetime} />
      <DropdownLabelsIntl
        items={ttlItems}
        selected={`${access.afterTtl}`}
        kind={'regular'}
        size={'medium'}
        on:selected={(e) => {
          void save({ afterTtl: Number(e.detail) })
        }}
      />
    {/if}
  </div>

  <div class="flex-col flex-gap-2">
    <div class="flex-row-center flex-gap-2">
      <Label label={plugin.string.GuestPassword} />
      <Label label={access.guestPassword !== undefined ? plugin.string.PasswordSet : plugin.string.PasswordNotSet} />
    </div>
    {#if editingPassword}
      <div class="flex-row-center flex-gap-2">
        <EditBox
          bind:value={passwordInput}
          format={'password'}
          placeholder={plugin.string.EnterPassword}
          kind={'default'}
          autoFocus
        />
        <Button label={plugin.string.SetPassword} disabled={passwordInput === ''} on:click={savePassword} />
      </div>
    {:else}
      <div class="flex-row-center flex-gap-2">
        <Button label={plugin.string.SetPassword} on:click={startEditPassword} />
        {#if access.guestPassword !== undefined}
          <Button kind={'dangerous'} label={plugin.string.RemovePassword} on:click={removePassword} />
        {/if}
        {#if plainPassword !== undefined}
          <Button label={plugin.string.CopyLinkWithPassword} on:click={copyLinkWithPassword} />
        {/if}
      </div>
    {/if}
  </div>

  <Button
    kind={'dangerous'}
    label={plugin.string.RevokeLink}
    showTooltip={{ label: plugin.string.RevokeLinkTooltip }}
    on:click={revoke}
  />
</div>

<style lang="scss">
  .grid {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 0.75rem;
    column-gap: 1rem;
    align-items: center;
  }
</style>
