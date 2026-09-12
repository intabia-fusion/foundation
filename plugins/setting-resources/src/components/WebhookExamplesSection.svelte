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
  import type { IntlString } from '@hcengineering/platform'
  import { Icon, Label } from '@hcengineering/ui'
  import settingsRes from '../plugin'

  export let onOpen: (id: 'incoming' | 'outgoing') => void

  const rows: Array<{ id: 'incoming' | 'outgoing', label: IntlString }> = [
    { id: 'incoming', label: settingsRes.string.WebhookExamplesIncoming },
    { id: 'outgoing', label: settingsRes.string.WebhookExamplesOutgoing }
  ]
</script>

<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={settingsRes.icon.Integrations} size="small" />
  <span><Label label={settingsRes.string.WebhookExamples} /></span>
</div>
<div class="hulyTableAttr-content task">
  {#each rows as row (row.id)}
    <button
      type="button"
      class="hulyTableAttr-content__row"
      data-id={`example-${row.id}`}
      on:click|stopPropagation={() => {
        onOpen(row.id)
      }}
    >
      <div class="hulyTableAttr-content__row-icon-wrapper">
        <Icon icon={settingsRes.icon.Setting} size="small" />
      </div>
      <div class="hulyTableAttr-content__row-label font-medium-14 grow">
        <Label label={row.label} />
      </div>
    </button>
  {/each}
</div>
