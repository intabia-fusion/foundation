//
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

import { type Domain, type Ref } from '@hcengineering/core'
import { type MigrationClient } from '@hcengineering/model'
import notification from '@hcengineering/notification'

import { DOMAIN_DOC_NOTIFY } from '../index'
import { type DocNotifyContextOld, type InboxNotification } from './types'

const DOMAIN_NOTIFICATION = 'notification' as Domain

export async function removeArchivedContexts (client: MigrationClient): Promise<void> {
  while (true) {
    const contexts = await client.find<DocNotifyContextOld>(
      DOMAIN_DOC_NOTIFY,
      {
        _class: notification.class.DocNotifyContext,
        archived: true
      },
      { limit: 500 }
    )

    if (contexts.length === 0) break

    const ids = contexts.map(({ _id }) => _id)

    // Delete associated old notifications in DOMAIN_NOTIFICATION
    await client.deleteMany<InboxNotification>(DOMAIN_NOTIFICATION, {
      docNotifyContext: { $in: ids }
    })

    // Delete the contexts themselves in DOMAIN_DOC_NOTIFY
    await client.deleteMany(DOMAIN_DOC_NOTIFY, {
      _class: notification.class.DocNotifyContext,
      _id: { $in: ids }
    })
  }
}

export async function removeArchivedNotifications (client: MigrationClient): Promise<void> {
  await client.deleteMany(DOMAIN_NOTIFICATION, { archived: true })
}

export async function removeEmptyContexts (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<DocNotifyContextOld>(DOMAIN_DOC_NOTIFY, {
    _class: notification.class.DocNotifyContext
  })

  const toDelete: Ref<DocNotifyContextOld>[] = []

  try {
    while (true) {
      const contexts = (await iterator.next(500)) ?? []
      if (contexts.length === 0) break

      const contextIds = contexts.map((c) => c._id)
      const notifications = await client.find<InboxNotification>(
        DOMAIN_NOTIFICATION,
        {
          docNotifyContext: { $in: contextIds }
        },
        { projection: { docNotifyContext: 1 } }
      )

      const activeContextIds = new Set(notifications.map((n) => n.docNotifyContext))
      for (const id of contextIds) {
        if (!activeContextIds.has(id)) {
          toDelete.push(id)
        }
      }

      while (toDelete.length >= 500) {
        const batch = toDelete.splice(0, 500)
        await client.deleteMany(DOMAIN_DOC_NOTIFY, {
          _class: notification.class.DocNotifyContext,
          _id: { $in: batch }
        })
      }
    }

    // Delete any remaining
    while (toDelete.length > 0) {
      const batch = toDelete.splice(0, 500)
      await client.deleteMany(DOMAIN_DOC_NOTIFY, {
        _class: notification.class.DocNotifyContext,
        _id: { $in: batch }
      })
    }
  } finally {
    await iterator.close()
  }
}
