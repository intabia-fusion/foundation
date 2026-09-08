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
  import { type WithLookup } from '@hcengineering/core'
  import love, { type PermanentMeeting } from '@hcengineering/love'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { Icon, tooltip } from '@hcengineering/ui'
  import { type ObjectPresenterType } from '@hcengineering/view'
  import { DocNavLink, ObjectMention } from '@hcengineering/view-resources'

  export let value: WithLookup<PermanentMeeting>
  export let inline: boolean = false
  export let disabled: boolean = false
  export let accent: boolean = false
  export let noUnderline: boolean = false
  export let shouldShowAvatar = true
  export let type: ObjectPresenterType = 'link'
</script>

{#if value}
  {#if inline}
    <ObjectMention object={value} {disabled} />
  {:else if type === 'link'}
    <DocNavLink object={value} {disabled} {accent} {noUnderline}>
      <div class="flex-presenter" use:tooltip={{ label: getEmbeddedLabel(value.name) }}>
        {#if shouldShowAvatar}
          <div class="icon">
            <Icon icon={love.icon.MeetingMinutes} size={'medium'} />
          </div>
        {/if}
        <div class="label nowrap" class:no-underline={noUnderline || disabled} class:fs-bold={accent}>
          {value.name}
        </div>
      </div>
    </DocNavLink>
  {:else}
    <span class="overflow-label" use:tooltip={{ label: getEmbeddedLabel(value.name) }}>{value.name}</span>
  {/if}
{/if}
