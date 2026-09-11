<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { Class, Doc, Ref } from '@hcengineering/core'
  import {
    AppPushNotification,
    translateNotification,
    PUSH_NOTIFICATION_TITLE_SIZE,
    PUSH_NOTIFICATION_BODY_SIZE,
    truncate
  } from '@hcengineering/notification'
  import { getClient } from '@hcengineering/presentation'
  import {
    addNotification,
    getCurrentResolvedLocation,
    Location,
    NotificationSeverity,
    languageStore,
    deviceOptionsStore,
    desktopPlatform
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { parseLinkId } from '@hcengineering/view-resources'
  import { Analytics } from '@hcengineering/analytics'
  import workbench, { Application } from '@hcengineering/workbench'
  import { getResource } from '@hcengineering/platform'

  import Notification from './Notification.svelte'
  import { appPushStore, removeAppPush, desktopPushEnabled } from '../appPush'

  const client = getClient()
  const linkProviders = client.getModel().findAllSync(view.mixin.LinkIdProvider, {})

  async function getObjectIdFromLocation (loc: Location): Promise<string | undefined> {
    const appAlias = loc.path[2]
    const application = client.getModel().findAllSync<Application>(workbench.class.Application, { alias: appAlias })[0]

    if (application?.locationDataResolver != null) {
      const resolver = await getResource(application.locationDataResolver)
      const data = await resolver(loc)
      return data.objectId
    } else {
      if (loc.fragment == null) return
      const [, id, _class] = decodeURIComponent(loc.fragment).split('|')
      if (_class == null) return
      try {
        return await parseLinkId(linkProviders, id, _class as Ref<Class<Doc>>)
      } catch (err: any) {
        Analytics.handleError(err)
      }
    }
  }

  $: if ($appPushStore && $appPushStore.length > 0) {
    for (const item of $appPushStore) {
      void notify(item)
    }
  }

  async function notify (value: AppPushNotification): Promise<void> {
    if ($deviceOptionsStore.isMobile) return
    if (desktopPlatform && $desktopPushEnabled) return

    const _id: Ref<Doc> | undefined = value.objectId
    void removeAppPush(value)

    const getSidebarObject = await getResource(workbench.function.GetSidebarObject)
    const sidebarObjectId = getSidebarObject()?._id

    if (_id != null && _id === sidebarObjectId) return

    const locObjectId = await getObjectIdFromLocation(getCurrentResolvedLocation())

    if (_id != null && _id === locObjectId) return

    const { title, body } = await translateNotification(value, $languageStore)

    addNotification(
      truncate(title, PUSH_NOTIFICATION_TITLE_SIZE),
      truncate(body, PUSH_NOTIFICATION_BODY_SIZE),
      Notification,
      { value },
      NotificationSeverity.Info,
      `notification-${value.objectId}`
    )
  }
</script>
