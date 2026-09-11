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
  import { ActivityMessagePreviewType, ActivityMessageLite } from '@hcengineering/activity'
  import { BaseMessagePreview } from '@hcengineering/activity-resources'
  import attachment from '@hcengineering/attachment'
  import { AttachmentsTooltip } from '@hcengineering/attachment-resources'
  import { ChatMessage } from '@hcengineering/chunter'
  import { createQuery } from '@hcengineering/presentation'
  import { Icon, Label, tooltip } from '@hcengineering/ui'
  import { isEmptyMarkup } from '@hcengineering/text'
  import { BlobType, Markup } from '@hcengineering/core'

  export let value: ActivityMessageLite<ChatMessage>
  export let attachments: BlobType[] | undefined = undefined
  export let readonly = false
  export let type: ActivityMessagePreviewType = 'full'

  const attachmentsQuery = createQuery()

  let _attachments: BlobType[] = []

  $: if ((attachments?.length ?? 0) > 0) {
    _attachments = attachments ?? []
  } else if (value.attachments !== undefined && value.attachments > 0) {
    attachmentsQuery.query(
      attachment.class.Attachment,
      {
        attachedTo: value._id
      },
      (res) => {
        _attachments = res
      }
    )
  } else {
    attachmentsQuery.unsubscribe()
  }

  function getText (message: ActivityMessageLite<ChatMessage>): Markup {
    if (!isEmptyMarkup(message.message)) {
      return message.message
    }

    if (message.forwardContent?.message == null) {
      return message.message
    }

    return message.forwardContent.message
  }
</script>

<BaseMessagePreview text={getText(value)} message={value} {type} {readonly} on:click>
  {#if value.attachments && !isEmptyMarkup(value.message)}
    <div class="attachments" use:tooltip={{ component: AttachmentsTooltip, props: { attachments: _attachments } }}>
      {value.attachments}
      <Icon icon={attachment.icon.Attachment} size="small" />
    </div>
  {:else if _attachments.length > 0 && isEmptyMarkup(value.message)}
    <span class="font-normal secondaryColor">
      <Label label={attachment.string.Attachments} />:
      {_attachments.map(({ name }) => name).join(', ')}
    </span>
  {:else if value.forwardContent?.attachments != null && value.forwardContent.attachments.length > 0 && isEmptyMarkup(value.forwardContent?.message ?? '')}
    <span class="font-normal secondaryColor">
      <Label label={attachment.string.Attachments} />:
      {value.forwardContent.attachments.map(({ name }) => name).join(', ')}
    </span>
  {/if}
</BaseMessagePreview>

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

  .secondaryColor {
    color: var(--global-secondary-TextColor);
    margin-left: -0.5rem;
  }
</style>
