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
import notification, { InboxNotification, TxNotificationType } from '@hcengineering/notification'
import { buildStorageFromConfig, storageConfigFrom } from '@hcengineering/server-storage'
import {
  loadBrandingMap,
  type PlatformQueue,
  type PlatformQueueProducer,
  QueueTopic,
  type QueueUserMessage,
  userEvents
} from '@hcengineering/server-core'
import { getAccountClient } from '@hcengineering/server-client'
import { PersonSpace } from '@hcengineering/contact'
import { aiBotEmailSocialKey } from '@hcengineering/ai-bot'
import platform from '@hcengineering/platform'

import Workspace from './workspace'
import { getTransactorApiEndpoint, getWorkspaceInfo, isTxTrigger, MAX_NOTIFICATION_TYPE_PRIORITY } from './utils'
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

    this.storage = buildStorageFromConfig(storageConfigFrom(config.StorageConfig))
    this.txTypes = this.sysModel
      .findAllSync(notification.class.TxNotificationType, {})
      .sort((a, b) => (a.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY) - (b.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY))
    this.triggerClasses = [
      notification.class.ReadState,
      activity.class.ActivityMessage,
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

    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.InboxNotification)) {
      await this.updateUserNotifyStatus(ctx, ws, tx as TxCUD<InboxNotification>)
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
    _tx: TxCUD<InboxNotification>
  ): Promise<AccountUuid | undefined> {
    if (_tx._class === core.class.TxCreateDoc) {
      return TxProcessor.createDoc2Doc(_tx as TxCreateDoc<InboxNotification>).user
    } else if (_tx._class === core.class.TxRemoveDoc) {
      const tx = _tx as TxRemoveDoc<InboxNotification>
      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      const space = await wsClient?.cache.findPersonSpace(tx.objectSpace as Ref<PersonSpace>)
      return space?.account
    } else if (_tx._class === core.class.TxUpdateDoc) {
      const tx = _tx as TxUpdateDoc<InboxNotification>
      if (tx.operations.isViewed == null) return undefined
      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      const space = await wsClient?.cache.findPersonSpace(tx.objectSpace as Ref<PersonSpace>)
      return space?.account
    }
    return undefined
  }

  private async updateUserNotifyStatus (
    ctx: MeasureContext,
    wsUuid: WorkspaceUuid,
    _tx: TxCUD<InboxNotification>
  ): Promise<void> {
    const user = await this.getTxUser(ctx, wsUuid, _tx)
    if (user == null || user === this.aiBotAccountUuid || user === systemAccountUuid) return

    if (_tx._class === core.class.TxCreateDoc) {
      const tx = _tx as TxCreateDoc<InboxNotification>
      const doc = TxProcessor.createDoc2Doc(tx)

      if (doc.isViewed || doc.archived) return

      this.scheduleStatusUpdate(user, wsUuid, true)
    } else {
      if (_tx._class === core.class.TxUpdateDoc) {
        const tx = _tx as TxUpdateDoc<InboxNotification>
        if (tx.operations.isViewed == null) return
      }

      const wsClient = await this.getWorkspaceClient(ctx, wsUuid)
      if (wsClient == null) return

      const unread = await wsClient.client.findOne(
        notification.class.InboxNotification,
        { user, isViewed: false, archived: false },
        { limit: 1 }
      )
      const notify = unread != null

      this.scheduleStatusUpdate(user, wsUuid, notify)
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
        if (wsInfo === undefined) return undefined

        const endpoint = getTransactorApiEndpoint(wsInfo)
        if (endpoint === undefined) return undefined

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
          this.txTypes
        )

        this.workspaces.set(ws, workspace)
        return workspace
      } catch (e: any) {
        if (e?.status?.code === platform.status.Forbidden) {
          ctx.error('Workspace is forbidden, dropping workspace initialization', { e, wsUuid: ws })
          return undefined
        }
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
    await Promise.allSettled([this.userEventProducer.close()])
  }
}
