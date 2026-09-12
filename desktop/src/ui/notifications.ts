//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { formatName, getPersonByPersonId } from '@hcengineering/contact'
import { Doc, Ref, TxOperations, WithLookup, Hierarchy } from '@hcengineering/core'
import notification, {
  notificationId,
  ActivityInboxNotification,
  CommonInboxNotification,
  DocNotifyContext,
  InboxNotification,
  getNotificationMessageId,
  getNotificationThreadId
} from '@hcengineering/notification'
import { addEventListener, IntlString, translate } from '@hcengineering/platform'
import { getClient, getCurrentWorkspaceUuid } from '@hcengineering/presentation'
import { location, languageStore } from '@hcengineering/ui'
import workbench, { workbenchId } from '@hcengineering/workbench'
import desktopPreferences, { defaultNotificationPreference } from '@hcengineering/desktop-preferences'
import { activePreferences } from '@hcengineering/desktop-preferences-resources'
import { getDisplayInboxData, InboxNotificationsClientImpl } from '@hcengineering/notification-resources'
import activity from '@hcengineering/activity'
import chunter, { ThreadMessage } from '@hcengineering/chunter'
import { workspacesNotificationStore, workspacesStore } from '@hcengineering/workbench-resources'

import { ipcMainExposed } from './typesUtils'
import { get } from 'svelte/store'

let client: TxOperations

async function hydrateNotificationAsYouCan (
  lastNotification: InboxNotification
): Promise<{ title: string, body: string } | undefined> {
  // try to do our best and figure out from who we have an notification

  if (client === undefined) {
    return undefined
  }

  if (lastNotification === undefined) {
    return undefined
  }

  let intlTitle: IntlString | undefined
  let intlParams: Record<string, any> = {}

  if (lastNotification._class === notification.class.CommonInboxNotification) {
    intlTitle = lastNotification.title ?? (lastNotification as CommonInboxNotification).message
    intlParams = { ...(lastNotification as CommonInboxNotification).intlParams }
  } else if (lastNotification._class === notification.class.ActivityInboxNotification) {
    intlTitle = lastNotification.title
    intlParams = { ...(lastNotification as ActivityInboxNotification).intlParams }
  }

  if (intlTitle !== undefined && lastNotification.body !== undefined) {
    if (lastNotification.intlParamsNotLocalized !== undefined) {
      for (const param in lastNotification.intlParamsNotLocalized) {
        const value = lastNotification.intlParamsNotLocalized[param]
        intlParams[param] = await translate(value, intlParams)
      }
    }
    const title = await translate(intlTitle, intlParams)
    const body = await translate(lastNotification.body, intlParams)

    // Do not show notification if there is no translate
    if (title === intlTitle || body === lastNotification.body) {
      return undefined
    }

    return { title, body }
  }

  const title = await translate(desktopPreferences.string.HaveGotANotification, {})

  // Do not show notification if there is no translate
  if (title === (lastNotification.title as string)) {
    return undefined
  }

  const noPersonData = {
    title,
    body: ''
  }

  const person = await getPersonByPersonId(client, lastNotification.modifiedBy)
  if (person == null) {
    return noPersonData
  }

  return {
    title,
    body: formatName(person.name)
  }
}

function getLasUnViewedNotification (
  notifications: InboxNotification[],
  notificationHistory: Map<string, number>
): InboxNotification | undefined {
  let lastNotification
  let lastTime = 0

  for (const n of notifications) {
    if (notificationHistory.has(n._id as string)) {
      continue
    }

    const createdOn = n.createdOn ?? n.modifiedOn

    notificationHistory.set(n._id as string, createdOn)

    if (createdOn > lastTime) {
      lastTime = createdOn
      lastNotification = n
    }
  }

  return lastNotification
}

/**
 * @public
 */
export function configureNotifications (): void {
  let preferences = defaultNotificationPreference
  let prevUnViewdNotificationsCount = 0

  // we want to track all notifications which happens after the launch
  // because we generate them on a client
  let initTimestamp = 0
  const notificationHistory = new Map<string, number>()

  addEventListener(workbench.event.NotifyConnection, async () => {
    client = getClient()
    const electronAPI = ipcMainExposed()

    const inboxClient = InboxNotificationsClientImpl.getClient()

    let hasOtherWorkspaceNotifications = false

    async function updateBadge (): Promise<void> {
      if (!preferences.showUnreadCounter) {
        electronAPI.setBadge(0)
        return
      }

      const total = prevUnViewdNotificationsCount
      if (total > 0) {
        const unreadsCountTooltip = await translate(
          notification.string.UnreadNotificationsCount,
          { count: total },
          get(languageStore)
        )
        electronAPI.setBadge(total, unreadsCountTooltip)
      } else if (hasOtherWorkspaceNotifications) {
        const unreadsTooltip = await translate(notification.string.HasNewNotifications, {}, get(languageStore))
        electronAPI.setBadge('•', unreadsTooltip)
      } else {
        electronAPI.setBadge(0)
      }
    }

    workspacesNotificationStore.subscribe((state) => {
      if (state != null) {
        const currentWorkspace = getCurrentWorkspaceUuid()
        const workspaces = get(workspacesStore)
        hasOtherWorkspaceNotifications = workspaces.some((it) => it.uuid !== currentWorkspace && state?.[it.uuid])
      }
      void updateBadge()
    })

    async function handleNotifications (
      notificationsByContext: Map<Ref<DocNotifyContext>, InboxNotification[]>
    ): Promise<void> {
      const inboxData = getDisplayInboxData(notificationsByContext)

      if (notificationHistory.size === 0) {
        for (const [, notifications] of inboxData) {
          for (const n of notifications) {
            notificationHistory.set(n._id as string, n.createdOn ?? n.modifiedOn)
          }
        }
      }

      const unViewedNotifications: InboxNotification[] = Array.from(inboxData.values())
        .flat()
        .filter(({ isViewed }) => !isViewed)
      // const notificationsAfterLaunch = notifications.filter((p) => p.txes.some((p) => p.modifiedOn > initTimestamp))
      // We need to get the most recent notifications

      if (prevUnViewdNotificationsCount !== unViewedNotifications.length) {
        prevUnViewdNotificationsCount = unViewedNotifications.length
        await updateBadge()

        if (preferences.bounceAppIcon) {
          electronAPI.dockBounce()
        }
      }

      const notification = getLasUnViewedNotification(unViewedNotifications, notificationHistory)

      if (preferences.showNotifications && initTimestamp > 0 && notification !== undefined) {
        const notificationData = await hydrateNotificationAsYouCan(notification)
        if (notificationData !== undefined) {
          if (notificationData.body === '') {
            notificationData.body = await translate(desktopPreferences.string.TotalNotificationsCount, {
              count: prevUnViewdNotificationsCount
            })
          }

          const object = getNotificationObjectIdentity(notification, client.getHierarchy())
          electronAPI.sendNotification({
            silent: !preferences.playSound,
            application: notificationId,
            objectId: object?._id ?? notification.objectId,
            objectClass: object?._class ?? notification.objectClass,
            messageId: getNotificationMessageId(notification, client.getHierarchy()),
            threadId: getNotificationThreadId(notification, client.getHierarchy()),
            ...notificationData
          })
        }
      }

      if (initTimestamp === 0) {
        initTimestamp = Date.now()
      }
    }

    inboxClient.inboxNotificationsByContext.subscribe((data) => {
      void handleNotifications(data)
    })

    activePreferences.subscribe((newPreferences) => {
      preferences = newPreferences
      void updateBadge()
    })
  })

  addEventListener(workbench.event.NotifyTitle, async (event, title: string) => {
    ipcMainExposed().setTitle(title)
  })

  location.subscribe((location) => {
    if (!(location.path[0] === workbenchId || location.path[0] === workbench.component.WorkbenchApp)) {
      // We need to clear badge
      ipcMainExposed().setBadge(0)
    }
  })
}

function getNotificationObjectIdentity (
  inboxNotification: WithLookup<InboxNotification>,
  hierarchy: Hierarchy
): Pick<Doc, '_id' | '_class'> {
  if (!hierarchy.isDerived(inboxNotification._class, notification.class.ActivityInboxNotification)) {
    return { _id: inboxNotification.objectId, _class: inboxNotification.objectClass }
  }

  const activityNotification = inboxNotification as WithLookup<ActivityInboxNotification>

  if (
    hierarchy.isDerived(activityNotification.attachedToClass, chunter.class.ThreadMessage) &&
    hierarchy.isDerived(activityNotification.objectClass, activity.class.ActivityMessage)
  ) {
    const attachedTo = activityNotification.$lookup?.attachedTo as ThreadMessage | undefined

    if (attachedTo != null) {
      return { _id: attachedTo.objectId, _class: attachedTo.objectClass }
    }
  }

  return { _id: activityNotification.objectId, _class: activityNotification.objectClass }
}
