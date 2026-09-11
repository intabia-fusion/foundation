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

import core, { generateId } from '@hcengineering/core'
import { DOMAIN_PREFERENCE } from '@hcengineering/preference'
import { type MigrationClient } from '@hcengineering/model'
import notification, { type DocNotificationSetting } from '@hcengineering/notification'

import { DOMAIN_DOC_NOTIFY } from '../index'
import { type DocNotifyContextOld } from './types'

export async function migrateDocNotifyContextSettings (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<DocNotifyContextOld>(DOMAIN_DOC_NOTIFY, {
    _class: notification.class.DocNotifyContext,
    'settings.mode': { $exists: true }
  })

  try {
    while (true) {
      const contexts = (await iterator.next(500)) ?? []
      if (contexts.length === 0) break

      for (const context of contexts) {
        if (
          context.settings?.mode != null &&
          context.objectId != null &&
          context.objectClass != null &&
          context.user != null
        ) {
          const existing = (
            await client.find<DocNotificationSetting>(DOMAIN_PREFERENCE, {
              _class: notification.class.DocNotificationSetting,
              attachedTo: context.objectId,
              account: context.user
            })
          )[0]
          if (existing == null) {
            await client.create<DocNotificationSetting>(DOMAIN_PREFERENCE, {
              _id: generateId<DocNotificationSetting>(),
              _class: notification.class.DocNotificationSetting,
              space: core.space.Workspace,
              attachedTo: context.objectId,
              attachedToClass: context.objectClass,
              account: context.user,
              mode: context.settings.mode,
              modifiedOn: Date.now(),
              createdOn: Date.now(),
              createdBy: core.account.System,
              modifiedBy: core.account.System
            })
          }
        }
      }
    }
  } finally {
    await iterator.close()
  }
}
