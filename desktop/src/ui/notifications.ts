//
// Copyright © 2025 Hardcore Engineering Inc.
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
//

import notification, {
  AppPushNotification,
  notificationId,
  translateNotification,
  PUSH_NOTIFICATION_TITLE_SIZE,
  PUSH_NOTIFICATION_BODY_SIZE,
  truncate
} from '@hcengineering/notification'
import { addEventListener, translate } from '@hcengineering/platform'
import { getCurrentWorkspaceUuid } from '@hcengineering/presentation'
import { location, languageStore } from '@hcengineering/ui'
import workbench, { workbenchId } from '@hcengineering/workbench'
import { defaultNotificationPreference, DesktopNotificationPreferenceData } from '@hcengineering/desktop-preferences'
import { crossWorkspaceNotificationStore, workspacesStore } from '@hcengineering/workbench-resources'
import { get } from 'svelte/store'
import { activePreferences } from '@hcengineering/desktop-preferences-resources'
import {
  NotificationClientImpl,
  appPushStore,
  removeAppPush,
  desktopPushEnabled
} from '@hcengineering/notification-resources'

import { ipcMainExposed } from './typesUtils'
import { IPCMainExposed } from './types'

export function configureNotifications (): void {
  let preferences = defaultNotificationPreference
  let unreadCount = 0
  let hasCrossWorkspaceNotifications = false

  addEventListener(workbench.event.NotifyConnection, async () => {
    const electronAPI = ipcMainExposed()
    const notificationClient = NotificationClientImpl.getClient()

    crossWorkspaceNotificationStore.subscribe((state) => {
      if (state != null) {
        const currentWorkspace = getCurrentWorkspaceUuid()
        const workspaces = get(workspacesStore)
        hasCrossWorkspaceNotifications = workspaces.some((it) => it.uuid !== currentWorkspace && state?.[it.uuid])
      }
      void updateBadge(electronAPI, preferences, unreadCount, hasCrossWorkspaceNotifications)
    })

    async function handlePush (appPush: AppPushNotification): Promise<void> {
      void removeAppPush(appPush)
      if (preferences.showNotifications) {
        const { title, body } = await translateNotification(
          {
            titleIntl: appPush.titleIntl,
            bodyIntl: appPush.bodyIntl,
            intlParams: appPush.intlParams,
            intlParamsNotLocalized: appPush.intlParamsNotLocalized
          },
          get(languageStore)
        )
        electronAPI.sendNotification({
          silent: !preferences.playSound && appPush.soundAlert,
          application: notificationId,
          title: truncate(title, PUSH_NOTIFICATION_TITLE_SIZE),
          body: truncate(body, PUSH_NOTIFICATION_BODY_SIZE),
          onClickLocation: appPush.onClickLocation
        })
      }
    }

    notificationClient.totalUnreadCount.subscribe((count) => {
      if (unreadCount === count) return
      unreadCount = count
      void updateBadge(electronAPI, preferences, unreadCount, hasCrossWorkspaceNotifications).then(() => {
        if (preferences.bounceAppIcon) {
          electronAPI.dockBounce()
        }
      })
    })

    appPushStore.subscribe((appPushs) => {
      if (appPushs == null) return
      for (const appPush of appPushs) {
        void handlePush(appPush)
      }
    })

    activePreferences.subscribe((newPreferences) => {
      preferences = newPreferences
      desktopPushEnabled.set(newPreferences.showNotifications)
      void updateBadge(electronAPI, preferences, unreadCount, hasCrossWorkspaceNotifications)
    })
  })

  addEventListener(workbench.event.NotifyTitle, async (_, title: string) => {
    ipcMainExposed().setTitle(title)
  })

  location.subscribe((location) => {
    if (!(location.path[0] === workbenchId || location.path[0] === workbench.component.WorkbenchApp)) {
      // We need to clear badge
      ipcMainExposed().setBadge(0)
    }
  })
}

async function updateBadge (
  electronAPI: IPCMainExposed,
  preferences: DesktopNotificationPreferenceData,
  count: number,
  hasCrossWorkspaceNotifications: boolean
): Promise<void> {
  if (!preferences.showUnreadCounter) {
    electronAPI.setBadge(0)
    return
  }

  if (count > 0) {
    const unreadCountTooltip = await translate(
      notification.string.UnreadNotificationsCount,
      { count },
      get(languageStore)
    )
    electronAPI.setBadge(count, unreadCountTooltip)
  } else if (hasCrossWorkspaceNotifications) {
    const unreadTooltip = await translate(notification.string.HasNewNotifications, {}, get(languageStore))
    electronAPI.setBadge('•', unreadTooltip)
  } else {
    electronAPI.setBadge(0)
  }
}
