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

import notification, { type AppPushNotification } from '@hcengineering/notification'
import { type Account, AccountRole, getCurrentAccount } from '@hcengineering/core'
import { createQuery, getClient, onClient } from '@hcengineering/presentation'
import { deviceOptionsStore, desktopPlatform } from '@hcengineering/ui'
import { get, writable } from 'svelte/store'

import { checkPermission, subscribePush, pushAllowed as webPushAllowed } from './webpush'

export const appPushStore = writable<AppPushNotification[]>([])
export const desktopPushEnabled = writable<boolean>(false)

const shownIds = new Set<string>()
const query = createQuery(true)

webPushAllowed.subscribe((allowed) => {
  void check(allowed, getCurrentAccount())
})

onClient((_, account) => {
  void check(get(webPushAllowed), account)
})

async function check (webPushAllowed: boolean, me?: Account): Promise<void> {
  if (me == null) return

  if (get(deviceOptionsStore).isMobile) {
    query.unsubscribe()
    return
  }
  if (!desktopPlatform) {
    if (webPushAllowed) {
      query.unsubscribe()
      return
    }
    const res = await checkPermission(true)
    if (res) {
      query.unsubscribe()
      return
    }
    const subscribeResult = await subscribePush()
    if (subscribeResult === 'success') {
      query.unsubscribe()
      return
    }
  }

  query.query(
    notification.class.AppPushNotification,
    {
      account: me.uuid
    },
    (res) => {
      const newItems = res.filter((item) => !shownIds.has(item._id))
      for (const item of newItems) {
        shownIds.add(item._id)
      }
      const currentIds = new Set<string>(res.map((it) => it._id))
      for (const id of shownIds) {
        if (!currentIds.has(id)) {
          shownIds.delete(id)
        }
      }
      appPushStore.set(newItems)
    }
  )
}

export async function removeAppPush (value: AppPushNotification): Promise<void> {
  const me = getCurrentAccount()
  if (me.role !== AccountRole.ReadOnlyGuest) {
    try {
      const client = getClient()
      await client.remove(value)
    } catch (err: any) {
      console.error('Failed to remove app push notification', err)
    }
  }
}
