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
  import { getClient } from '@hcengineering/presentation'
  import { Class, Doc, matchQuery, Ref, Space } from '@hcengineering/core'
  import { ActivityNotificationViewlet, MessageNotification, NotificationMessage } from '@hcengineering/notification'
  import { ActivityMessagePreview, BasePreview } from '@hcengineering/activity-resources'
  import activity, { DocUpdateMessage } from '@hcengineering/activity'
  import { Component } from '@hcengineering/ui'
  import { Analytics } from '@hcengineering/analytics'

  export let objectId: Ref<Doc>
  export let objectClass: Ref<Class<Doc>>
  export let objectSpace: Ref<Space>
  export let value: MessageNotification
  export let viewlets: ActivityNotificationViewlet[] = []

  const client = getClient()

  let viewlet: ActivityNotificationViewlet | undefined = undefined

  $: updateViewlet(viewlets, value.message)

  function matchViewlet (viewlet: ActivityNotificationViewlet, message: NotificationMessage): boolean {
    const hierarchy = client.getHierarchy()
    const matched = matchQuery([message], viewlet.messageMatch, message._class, hierarchy, true)[0]
    if (matched !== undefined) return true

    if (hierarchy.isDerived(message._class, activity.class.DocUpdateMessage)) {
      const dum = message as DocUpdateMessage
      const dumUpdated: DocUpdateMessage = {
        ...dum,
        objectClass: hierarchy.getParentClass(dum.objectClass)
      }
      const matched = matchQuery([dumUpdated], viewlet.messageMatch, message._class, hierarchy, true)[0]
      return matched !== undefined
    }

    return false
  }

  function updateViewlet (viewlets: ActivityNotificationViewlet[], message: NotificationMessage): void {
    if (viewlets.length === 0 || message === undefined) {
      viewlet = undefined
      return
    }

    for (const v of viewlets) {
      try {
        const matched = matchViewlet(v, message)
        if (matched) {
          viewlet = v
          return
        }
      } catch (err: any) {
        Analytics.handleError(err)
      }
    }

    viewlet = undefined
  }
</script>

{#if viewlet}
  <Component
    is={viewlet.presenter}
    props={{ value, objectId, objectClass, objectSpace }}
    showLoading={false}
    on:click
  />
{:else if value.intlMessage}
  <BasePreview intlLabel={value.intlMessage} account={value.createdBy} timestamp={value.createdOn} on:click />
{:else}
  <ActivityMessagePreview space={objectSpace} attachments={value.attachments} value={value.message} on:click />
{/if}
