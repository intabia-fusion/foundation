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
  import { ActivityMessagePreview, BasePreview } from '@hcengineering/activity-resources'
  import { ReactionNotification } from '@hcengineering/notification'
  import { EmojiPresenter } from '@hcengineering/emoji-resources'

  import notification from '../../plugin'
  import { Class, Doc, Ref } from '@hcengineering/core'

  export let value: ReactionNotification
  export let objectId: Ref<Doc>
  export let objectClass: Ref<Class<Doc>>
</script>

<div class="reaction-notification" on:click>
  <BasePreview
    intlLabel={notification.string.ReactedToYourMessage}
    color="secondary"
    lower
    account={value.createdBy}
    timestamp={value.createdOn}
  />

  <div class="reaction-notification__body">
    <div class="reaction-notification__emoji">
      <EmojiPresenter emoji={value.reaction.image ?? value.reaction.emoji} fitSize center />
    </div>
    <ActivityMessagePreview
      value={{ ...value.message, attachedTo: objectId, attachedToClass: objectClass }}
      type="content-only"
    />
  </div>
</div>

<style lang="scss">
  .reaction-notification {
    display: flex;
    flex-direction: column;
    color: var(--global-secondary-TextColor);
    white-space: nowrap;

    &__body {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding-right: var(--spacing-0_75);
      padding-left: var(--spacing-1_25);
    }

    &__emoji {
      display: flex;
      align-items: center;
      font-size: 1.25rem;
      width: 1.325rem;
      min-width: 1.325rem;
      min-height: 1.325rem;
      height: 1.325rem;
      overflow: hidden;
      margin-right: 0.25rem;
    }
  }
</style>
