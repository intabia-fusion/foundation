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
  import { ActivityNotificationViewlet, ContextNotification } from '@hcengineering/notification'
  import { Class, Doc, Ref, Space } from '@hcengineering/core'

  import MessageNotificationPresenter from './MessageNotificationPresenter.svelte'
  import MentionNotificationPresenter from './MentionNotificationPresenter.svelte'
  import ReactionNotificationPresenter from './ReactionNotificationPresenter.svelte'
  import CommonNotificationPresenter from './CommonNotificationPresenter.svelte'

  export let objectId: Ref<Doc>
  export let objectClass: Ref<Class<Doc>>
  export let objectSpace: Ref<Space>
  export let value: ContextNotification
  export let viewlets: ActivityNotificationViewlet[] = []
</script>

{#if value.type === 'message'}
  <MessageNotificationPresenter {objectId} {objectClass} {objectSpace} {value} {viewlets} on:click />
{:else if value.type === 'mention'}
  <MentionNotificationPresenter {value} on:click />
{:else if value.type === 'reaction'}
  <ReactionNotificationPresenter {value} {objectId} {objectClass} on:click />
{:else if value.type === 'common'}
  <CommonNotificationPresenter {value} />
{/if}
