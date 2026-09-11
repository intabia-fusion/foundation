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

import { type MigrateUpdate, type MigrationClient, type MigrationDocumentQuery } from '@hcengineering/model'
import notification, { DOMAIN_DOC_NOTIFY, type ReadPosition, type ReadState } from '@hcengineering/notification'
import { type ActivityMessage } from '@hcengineering/activity'
import { type AccountUuid, generateId, type Ref, SortingOrder } from '@hcengineering/core'
import { DOMAIN_ACTIVITY } from '@hcengineering/model-activity'

import { DOMAIN_READ_STATE } from '../index'
import { type DocNotifyContextOld } from './types'

export async function initReadStatesLatestMessages (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<ReadState>(DOMAIN_READ_STATE, {
    _class: notification.class.ReadState,
    latestMessageId: { $exists: false }
  })

  try {
    let processed = 0
    while (true) {
      const docs = (await iterator.next(100)) ?? []
      if (docs.length === 0) break

      const updates: {
        filter: MigrationDocumentQuery<ReadState>
        update: MigrateUpdate<ReadState>
      }[] = []

      for (const doc of docs) {
        const messages = await client.find<any>(
          DOMAIN_ACTIVITY,
          {
            attachedTo: doc.attachedTo
          },
          {
            sort: { createdOn: -1 },
            limit: 1
          }
        )

        if (messages.length > 0) {
          const latestMessage = messages[0]
          updates.push({
            filter: { _id: doc._id },
            update: {
              latestMessageId: latestMessage._id,
              latestMessageTimestamp: latestMessage.createdOn ?? latestMessage.modifiedOn
            }
          })
        }
      }

      if (updates.length > 0) {
        await client.bulk(DOMAIN_READ_STATE, updates)
      }

      processed += docs.length
      client.logger.log('...processed read states latest messages initialization', { count: processed })
    }
  } finally {
    await iterator.close()
  }
}

export async function updateReadStatesFromDocNotifyContexts (client: MigrationClient): Promise<void> {
  const iterator = await client.traverse<DocNotifyContextOld>(DOMAIN_DOC_NOTIFY, {
    _class: notification.class.DocNotifyContext,
    lastView: { $exists: true }
  })

  try {
    let processed = 0
    while (true) {
      const contexts = (await iterator.next(100)) ?? []
      if (contexts.length === 0) break

      const objectIds = contexts.map((c) => c.objectId)

      // Fetch ReadStates for these objectIds
      const readStates = await client.find<ReadState>(DOMAIN_READ_STATE, {
        _class: notification.class.ReadState,
        attachedTo: { $in: objectIds }
      })
      const readStateMap = new Map<string, ReadState>()
      for (const rs of readStates) {
        readStateMap.set(rs.attachedTo, rs)
      }

      const readStateUpdates = new Map<Ref<ReadState>, Record<AccountUuid, ReadPosition>>()

      for (const context of contexts) {
        if (context.user == null) continue
        const userUuid = context.user

        const readState = readStateMap.get(context.objectId)
        if (readState === undefined) continue

        const existingPosition = (readState as any)[userUuid]
        const existingTs = existingPosition?.timestamp ?? 0
        const lastViewTs = context.lastView ?? 0
        const maxTs = Math.max(existingTs, lastViewTs)

        if (maxTs === 0) continue
        if (maxTs > existingTs) {
          // Find the latest ActivityMessage for this objectId up to maxTs
          const messages = await client.find<ActivityMessage>(
            DOMAIN_ACTIVITY,
            {
              attachedTo: context.objectId,
              createdOn: { $lte: maxTs }
            },
            {
              sort: { createdOn: SortingOrder.Descending },
              limit: 1
            }
          )

          const messageId = messages.length > 0 ? messages[0]._id : undefined

          let fields = readStateUpdates.get(readState._id)
          if (fields === undefined) {
            fields = {}
            readStateUpdates.set(readState._id, fields)
          }
          fields[userUuid] = {
            messageId: messageId ?? generateId(),
            timestamp: maxTs
          }
        }
      }

      const updates: {
        filter: MigrationDocumentQuery<ReadState>
        update: MigrateUpdate<ReadState>
      }[] = []

      for (const [_id, fields] of readStateUpdates.entries()) {
        updates.push({
          filter: { _id },
          update: { $set: fields }
        })
      }

      if (updates.length > 0) {
        await client.bulk(DOMAIN_READ_STATE, updates)
      }

      processed += contexts.length
      client.logger.log('...processed read states from context migration', { count: processed })
    }
  } finally {
    await iterator.close()
  }
}
