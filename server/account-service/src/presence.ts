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

import { type AccountDB } from '@hcengineering/account'
import core, {
  type AccountUuid,
  type MeasureContext,
  type Ref,
  generateId,
  type TxCreateDoc,
  type WorkspaceUuid,
  groupByArray
} from '@hcengineering/core'
import {
  QueueTopic,
  QueueUserEvent,
  type QueueUserMessage,
  type ConsumerMessage,
  type QueueOnlineUserTx,
  type PlatformQueue
} from '@hcengineering/server-core'
import pulse, { type WorkspacesNotification } from '@hcengineering/pulse'
import { type PersonSpace } from '@hcengineering/contact'

export async function handlePresenceBatch (
  ctx: MeasureContext,
  msgs: ConsumerMessage<QueueUserMessage>[],
  _db: Promise<[AccountDB, () => void]>,
  regionalQueue: PlatformQueue
): Promise<void> {
  const [db] = await _db
  const usersWithBadgeUpdates = new Set<AccountUuid>()
  const badgeUpdatesMap = new Map<string, { accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }>()

  for (const msg of msgs) {
    if (msg.value.type === QueueUserEvent.notifyStatusChanged) {
      const { user, hasUnread } = msg.value
      badgeUpdatesMap.set(`${user}:${msg.workspace}`, {
        accountId: user,
        workspaceId: msg.workspace,
        hasUnread
      })
      usersWithBadgeUpdates.add(user)
    } else if (msg.value.type === QueueUserEvent.login) {
      usersWithBadgeUpdates.add(msg.value.user)
    }
  }

  if (badgeUpdatesMap.size > 0) {
    await db.batchWorkspaceBadgeStatuses(Array.from(badgeUpdatesMap.values()))
  }

  if (usersWithBadgeUpdates.size > 0) {
    const userIds = Array.from(usersWithBadgeUpdates)
    const allStatuses = await db.accountWorkspaceBadgeStatus.find({ accountUuid: { $in: userIds } })
    const statusesByUser = groupByArray(allStatuses, (it) => it.accountUuid)

    // A user's workspaces may live in different regions: notify each workspace in its own region topic
    const allWsIds = Array.from(new Set(allStatuses.map((it) => it.workspaceUuid)))
    const wsRegions = new Map<WorkspaceUuid, string>(
      (await db.workspace.find({ uuid: { $in: allWsIds } })).map((it) => [it.uuid, it.region ?? ''])
    )

    for (const user of userIds) {
      const userStatuses = statusesByUser.get(user) ?? []
      const unreadStatusByWorkspace: Record<WorkspaceUuid, boolean> = {}
      for (const s of userStatuses) unreadStatusByWorkspace[s.workspaceUuid] = s.hasUnread
      const workspaces = new Set<WorkspaceUuid>(userStatuses.map((it) => it.workspaceUuid))

      const tx: TxCreateDoc<WorkspacesNotification> = {
        _id: generateId(),
        _class: core.class.TxCreateDoc,
        objectId: generateId(),
        objectClass: pulse.class.WorkspacesNotification,
        objectSpace: core.space.Workspace as Ref<PersonSpace>, // Replace it with real person space in middleware
        space: core.space.DerivedTx,
        modifiedBy: core.account.System,
        modifiedOn: Date.now(),
        createdBy: core.account.System,
        attributes: {
          account: user,
          ...unreadStatusByWorkspace
        }
      }

      // One send per region the user's workspaces live in - the payload is identical and the
      // account is the partition key, so a user's updates stay ordered.
      const wsByRegion = new Map<string, WorkspaceUuid>()
      for (const wsUuid of workspaces) {
        const region = wsRegions.get(wsUuid) ?? ''
        if (!wsByRegion.has(region)) wsByRegion.set(region, wsUuid)
      }
      for (const [region, wsUuid] of wsByRegion) {
        const producer = regionalQueue.getProducer<QueueOnlineUserTx>(ctx, QueueTopic.OnlineUserTx, region)
        await producer.send(ctx, wsUuid, [{ tx, account: user }], user)
      }
    }
  }
}
