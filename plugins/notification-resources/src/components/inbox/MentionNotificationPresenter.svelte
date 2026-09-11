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
  import { BasePreview } from '@hcengineering/activity-resources'
  import { MentionNotification } from '@hcengineering/notification'
  import { Icon, tooltip } from '@hcengineering/ui'
  import { AttachmentsTooltip } from '@hcengineering/attachment-resources'
  import attachment from '@hcengineering/attachment'

  export let value: MentionNotification

  $: attachments = value.attachments ?? []
</script>

<BasePreview text={value.markup} timestamp={value.createdOn} account={value.createdBy} on:click>
  {#if attachments.length > 0}
    <div class="attachments" use:tooltip={{ component: AttachmentsTooltip, props: { attachments } }}>
      {value.attachments}
      <Icon icon={attachment.icon.Attachment} size="small" />
    </div>
  {/if}
</BasePreview>

<style lang="scss">
  .attachments {
    margin-left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--global-secondary-TextColor);

    &:hover {
      cursor: pointer;
      color: var(--global-primary-TextColor);
    }
  }
</style>
