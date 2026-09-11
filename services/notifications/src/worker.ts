//
// Copyright © 2026 Intabia Fusion Inc.
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

import core, {
  AccountUuid,
  Branding,
  Class,
  Doc,
  Hierarchy,
  MeasureContext,
  ModelDb,
  Ref,
  systemAccountUuid,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc,
  WorkspaceUuid
} from '@hcengineering/core'
import activity from '@hcengineering/activity'
import { generateToken } from '@hcengineering/server-token'
import { createRestClient } from '@hcengineering/api-client'
import { StorageAdapter } from '@hcengineering/storage'
import {
  loadBrandingMap,
  type PlatformQueue,
  type PlatformQueueProducer,
  QueueTopic,
  type QueueUserMessage,
  userEvents
} from '@hcengineering/server-core'
import { getAccountClient } from '@hcengineering/server-client'
import { aiBotEmailSocialKey } from '@hcengineering/ai-bot'
import platform from '@hcengineering/platform'
import notification, {
  TxNotificationType,
  QueueNotificationMessage,
  DocNotifyContext
} from '@hcengineering/notification'
import { buildStorageFromConfig, storageConfigFrom } from '@hcengineering/server-storage'
import { PersonSpace } from '@hcengineering/contact'

import Workspace from './workspace'
import { getTransactorApiEndpoint, getWorkspaceInfo, isTxTrigger, MAX_NOTIFICATION_TYPE_PRIORITY } from './utils/utils'
import config from './config'

export class Worker {
  private readonly sysHierarchy = new Hierarchy()
  private readonly sysModel = new ModelDb(this.sysHierarchy)

  private readonly workspaces = new Map<WorkspaceUuid, Workspace>()

  private readonly txTypes: TxNotificationType[] = []
  private readonly triggerClasses: Ref<Class<Doc>>[]

  private readonly storage: StorageAdapter

  private readonly clearInterval: NodeJS.Timeout | undefined = undefined
  private readonly flushInterval: NodeJS.Timeout | undefined = undefined

  private readonly pendingStatusUpdates = new Map<AccountUuid, Record<WorkspaceUuid, boolean>>()

  private readonly pendingWorkspaces = new Map<WorkspaceUuid, Promise<Workspace | undefined>>()
  private readonly userEventProducer: PlatformQueueProducer<QueueUserMessage>
  private readonly producer: PlatformQueueProducer<QueueNotificationMessage>

  private aiBotAccountUuid?: AccountUuid

  private readonly brandingMap = loadBrandingMap(config.BrandingPath)

  constructor (
    private readonly ctx: MeasureContext,
    private readonly modelTxes: Tx[],
    private readonly queue: PlatformQueue
  ) {
    // addTxes feeds sysHierarchy itself, a separate pass would just deserialize everything twice.
    this.sysModel.addTxes(ctx, modelTxes, true)

    this.userEventProducer = this.queue.getProducer(
      ctx.newChild('user-event-producer', {}, { span: false }),
      QueueTopic.Users
    )

    this.producer = queue.getProducer<QueueNotificationMessage>(ctx, QueueTopic.UserNotifications)

    this.storage = buildStorageFromConfig(storageConfigFrom(config.StorageConfig))
    this.txTypes = this.sysModel
      .findAllSync(notification.class.TxNotificationType, {})
      .sort((a, b) => (a.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY) - (b.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY))
    this.triggerClasses = [
      notification.class.ReadState,
      activity.class.ActivityMessage,
      activity.class.Reaction,
      notification.class.ReadNotificationAction,
      notification.class.CreateNotificationAction,
      ...this.txTypes.map((it) => it.objectClass)
    ].filter((it) => it !== core.class.Doc)

    this.clearInterval = setInterval(
      () => {
        const now = Date.now()
        for (const [uuid, workspace] of this.workspaces.entries()) {
          if (workspace.isInProgress()) continue
          const time = workspace.getLastTxDate() ?? 0
          const diff = now - time
          if (diff < 5 * 60 * 1000) continue
          void workspace.close()
          this.workspaces.delete(uuid)
        }
      },
      5 * 60 * 1000 // 5 minutes
    )

    this.flushInterval = setInterval(() => {
      void this.flushPendingUpdates()
    }, 1000)
  }

  private async flushPendingUpdates (): Promise<void> {
    if (this.pendingStatusUpdates.size === 0) return

    const updates = Array.from(this.pendingStatusUpdates.entries())
    this.pendingStatusUpdates.clear()
    const timestamp = Date.now()

    for (const [user, statuses] of updates) {
      for (const [wsUuid, hasUnread] of Object.entries(statuses)) {
        try {
          await this.userEventProducer.send(
            this.ctx,
            wsUuid as WorkspaceUuid,
            [userEvents.notifyStatusChanged({ user, hasUnread, timestamp })],
            user
          )
        } catch (e) {
          this.ctx.error('Failed to send notifyStatusChanged to queue', { e, user, wsUuid, hasUnread })

          let currentMap = this.pendingStatusUpdates.get(user)
          if (currentMap === undefined) {
            currentMap = {}
            this.pendingStatusUpdates.set(user, currentMap)
          }

          if (currentMap[wsUuid as WorkspaceUuid] === undefined) {
            currentMap[wsUuid as WorkspaceUuid] = hasUnread
          }
        }
      }
    }
  }

  public async resolveAiBotAccount (): Promise<void> {
    if (this.aiBotAccountUuid != null) return
    try {
      const token = generateToken(systemAccountUuid, undefined, { service: config.ServiceId })
      const client = getAccountClient(token)
      const socialId = await client.findFullSocialIdBySocialKey(aiBotEmailSocialKey)
      if (socialId != null) {
        this.aiBotAccountUuid = socialId.personUuid as AccountUuid
      }
    } catch (e) {
      this.ctx.error('Failed to resolve AI bot account', { e })
    }
  }

  async tx (ctx: MeasureContext, ws: WorkspaceUuid, _tx: Tx): Promise<void> {
    if (!TxProcessor.isExtendsCUD(_tx._class)) return

    const tx = _tx as TxCUD<Doc>

    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      await this.updateUserNotifyStatus(ctx, ws, tx as TxCUD<DocNotifyContext>)
    }

    const exists = this.workspaces.get(ws)

    if (tx.meta?.silent === true && exists === undefined) {
      return
    }

    const isTrigger = isTxTrigger(this.sysHierarchy, tx, this.triggerClasses, this.txTypes)

    if (exists === undefined && !isTrigger) {
      return
    }

    const workspace = await this.getWorkspaceClient(ctx, ws)
    if (workspace == null) return

    await workspace.tx(tx)
  }

  private async getTxUser (
    ctx: MeasureContext,
    wsUuid: WorkspaceUuid,
    _tx: TxCUD<DocNotifyContext>
  ): Promise<AccountUuid | undefined> {
    if (_tx._class === core.class.TxCreateDoc) {
      return TxProcessor.createDoc2Doc(_tx as TxCreateDoc<DocNotifyContext>).user
    } else if (_tx._class === core.class.TxRemoveDoc) {
      const tx = _tx as TxRemoveDoc<DocNotifyContext>
      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      const space = await wsClient?.cache.findPersonSpace(tx.objectSpace as Ref<PersonSpace>)
      return space?.account
    } else if (_tx._class === core.class.TxUpdateDoc) {
      const tx = _tx as TxUpdateDoc<DocNotifyContext>
      if (tx.operations.unreadCount == null && tx.operations.$inc?.unreadCount == null) return undefined
      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      const space = await wsClient?.cache.findPersonSpace(tx.objectSpace as Ref<PersonSpace>)
      return space?.account
    }
    return undefined
  }

  private async updateUserNotifyStatus (
    ctx: MeasureContext,
    wsUuid: WorkspaceUuid,
    _tx: TxCUD<DocNotifyContext>
  ): Promise<void> {
    const user = await this.getTxUser(ctx, wsUuid, _tx)
    if (user == null || user === this.aiBotAccountUuid || user === systemAccountUuid) return

    if (_tx._class === core.class.TxCreateDoc) {
      this.scheduleStatusUpdate(user, wsUuid, true)
    } else {
      let unread = false
      if (_tx._class === core.class.TxUpdateDoc) {
        const tx = _tx as TxUpdateDoc<DocNotifyContext>
        if (tx.operations.unreadCount == null && tx.operations.$inc?.unreadCount == null) return
        if (tx.operations.unreadCount != null && tx.operations.unreadCount > 0) {
          unread = true
        }
        if (tx.operations.$inc?.unreadCount != null && tx.operations.$inc.unreadCount > 0) {
          unread = true
        }
      }

      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      if (wsClient == null) return

      unread =
        unread ||
        (await wsClient.client.findOne(
          notification.class.DocNotifyContext,
          { user, unreadCount: { $gt: 0 } },
          { limit: 1, projection: { _id: 1, unreadCount: 1, user: 1 } }
        )) != null

      this.scheduleStatusUpdate(user, wsUuid, unread)
    }
  }

  private scheduleStatusUpdate (user: AccountUuid, wsUuid: WorkspaceUuid, hasUnread: boolean): void {
    let userMap = this.pendingStatusUpdates.get(user)
    if (userMap === undefined) {
      userMap = {}
      this.pendingStatusUpdates.set(user, userMap)
    }
    userMap[wsUuid] = hasUnread
  }

  private async getWorkspaceClient (ctx: MeasureContext, ws: WorkspaceUuid): Promise<Workspace | undefined> {
    const exists = this.workspaces.get(ws)
    if (exists !== undefined) return exists

    const pending = this.pendingWorkspaces.get(ws)
    if (pending !== undefined) return await pending

    const promise = (async () => {
      try {
        const token = generateToken(systemAccountUuid, ws, { service: config.ServiceId })
        const wsInfo = await getWorkspaceInfo(token)
        if (wsInfo === undefined) {
          ctx.warn('Workspace info not found, dropping workspace client initialization', { wsUuid: ws })
          return undefined
        }

        const endpoint = getTransactorApiEndpoint(wsInfo)
        if (endpoint === undefined) {
          ctx.warn('Transactor API endpoint not found in workspace info, dropping workspace client initialization', {
            wsUuid: ws,
            wsInfo
          })
          return undefined
        }

        const client = createRestClient(endpoint, ws, token)

        const { model, hierarchy } = await client.getModel(true)
        const branding: Branding | undefined =
          wsInfo.branding !== undefined && wsInfo.branding !== ''
            ? (this.brandingMap[wsInfo.branding] ?? this.brandingMap[Object.keys(this.brandingMap)[0]])
            : this.brandingMap[Object.keys(this.brandingMap)[0]]
        const workspace = await Workspace.create(
          ctx.newChild(ws, {}),
          wsInfo,
          hierarchy,
          model,
          this.modelTxes,
          this.storage,
          client,
          branding,
          this.txTypes,
          this.producer
        )

        this.workspaces.set(ws, workspace)
        return workspace
      } catch (e: any) {
        if (e?.status?.code === platform.status.Forbidden) {
          ctx.error('Workspace is forbidden, dropping workspace initialization', { e, wsUuid: ws })
          return undefined
        }
        ctx.error('Failed to initialize workspace client', { e, wsUuid: ws })
        throw e
      } finally {
        this.pendingWorkspaces.delete(ws)
      }
    })()

    this.pendingWorkspaces.set(ws, promise)
    return await promise
  }

  public async close (): Promise<void> {
    clearInterval(this.clearInterval)
    clearInterval(this.flushInterval)
    this.pendingStatusUpdates.clear()
    await Promise.allSettled([this.userEventProducer.close(), this.producer.close()])
  }
}
