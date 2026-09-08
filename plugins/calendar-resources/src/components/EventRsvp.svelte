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
  import { AccessLevel, type Event, type RsvpStatus, rsvpPending } from '@hcengineering/calendar'
  import { getClient } from '@hcengineering/presentation'
  import { Button, Label } from '@hcengineering/ui'
  import calendar from '../plugin'

  export let object: Event

  const client = getClient()

  // The organiser holds the master; everyone else holds their own copy and answers in it.
  $: isOrganiser = object.access === AccessLevel.Owner
  $: summary = object.rsvpSummary
  $: pending = rsvpPending(object.participants.length, summary)

  async function answer (rsvp: RsvpStatus): Promise<void> {
    await client.update(object, { rsvp })
  }
</script>

{#if isOrganiser}
  {#if object.participants.length > 0}
    <div class="flex-row-center flex-gap-2 rsvp-summary">
      {#if (summary?.accepted ?? 0) > 0}
        <span>{summary?.accepted} <Label label={calendar.string.RsvpAccepted} /></span>
      {/if}
      {#if (summary?.declined ?? 0) > 0}
        <span>{summary?.declined} <Label label={calendar.string.RsvpDeclined} /></span>
      {/if}
      {#if (summary?.tentative ?? 0) > 0}
        <span>{summary?.tentative} <Label label={calendar.string.RsvpTentative} /></span>
      {/if}
      {#if pending > 0}
        <span class="content-darker-color">{pending} <Label label={calendar.string.RsvpPending} /></span>
      {/if}
    </div>
  {/if}
{:else}
  <div class="flex-row-center flex-gap-2">
    <Label label={calendar.string.WillYouAttend} />
    <Button
      label={calendar.string.Going}
      kind={object.rsvp === 'accepted' ? 'primary' : 'regular'}
      size={'small'}
      on:click={() => answer('accepted')}
    />
    <Button
      label={calendar.string.Maybe}
      kind={object.rsvp === 'tentative' ? 'primary' : 'regular'}
      size={'small'}
      on:click={() => answer('tentative')}
    />
    <Button
      label={calendar.string.NotGoing}
      kind={object.rsvp === 'declined' ? 'dangerous' : 'regular'}
      size={'small'}
      on:click={() => answer('declined')}
    />
  </div>
{/if}

<style lang="scss">
  .rsvp-summary {
    font-size: 0.75rem;
    color: var(--theme-content-color);
  }
</style>
