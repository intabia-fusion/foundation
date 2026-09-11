/**
 Copyright © 2026 Intabia Fusion.

 Licensed under the Eclipse Public License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License. You may
 obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { createQuery } from '@hcengineering/presentation'
import notification, {
  type DocNotifyContext,
  type NotificationAppearancePreference,
  type NotificationProviderSetting,
  type NotificationTypeSetting
} from '@hcengineering/notification'
import { writable } from 'svelte/store'
import core, { getCurrentAccount, type DocumentQuery, SortingOrder } from '@hcengineering/core'

const appearancePreferenceQuery = createQuery(true)
const inboxContextsQuery = createQuery(true)
const providerSettingsQuery = createQuery(true)
const typeSettingsQuery = createQuery(true)

export const inboxContextsStore = writable<DocNotifyContext[]>([])
export const hasInboxNextPageStore = writable<boolean>(true)

export const appearancePreferences = writable<NotificationAppearancePreference | undefined>(undefined)

export const providersSettings = writable<NotificationProviderSetting[]>([])
export const typesSettings = writable<NotificationTypeSetting[]>([])

export function loadNotificationSettings (): void {
  providerSettingsQuery.query(
    notification.class.NotificationProviderSetting,
    { space: core.space.Workspace },
    (res) => {
      providersSettings.set(res)
    }
  )

  typeSettingsQuery.query(notification.class.NotificationTypeSetting, { space: core.space.Workspace }, (res) => {
    typesSettings.set(res)
  })
}

loadNotificationSettings()

appearancePreferenceQuery.query(
  notification.class.NotificationAppearancePreference,
  {},
  (res: NotificationAppearancePreference[]) => {
    appearancePreferences.set(res[0])
  }
)

export function updateInboxContexts (query: DocumentQuery<DocNotifyContext>, limit: number): void {
  const account = getCurrentAccount()

  inboxContextsQuery.query(
    notification.class.DocNotifyContext,
    {
      ...query,
      latestNotifications: { $size: { $gt: 0 } },
      user: account.uuid
    },
    (res) => {
      if (res.length <= limit) {
        hasInboxNextPageStore.set(false)
      } else {
        hasInboxNextPageStore.set(true)
        res.pop()
      }
      inboxContextsStore.set(res)
    },
    {
      sort: {
        lastNotify: SortingOrder.Descending
      },
      limit: limit + 1
    }
  )
}
