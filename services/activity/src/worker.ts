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
  type Doc,
  Hierarchy,
  type MeasureContext,
  ModelDb,
  systemAccountUuid,
  type Tx,
  type TxCUD,
  TxProcessor,
  type WorkspaceUuid,
  type Branding,
  DOMAIN_TRANSIENT,
  type WorkspaceInfoWithStatus
} from '@hcengineering/core'
import { loadBrandingMap } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import { createRestClient } from '@hcengineering/api-client'
import { type StorageAdapter } from '@hcengineering/storage'
import { buildStorageFromConfig, storageConfigFrom } from '@hcengineering/server-storage'
import activity from '@hcengineering/activity'
import notification from '@hcengineering/notification'
import platform from '@hcengineering/platform'
import pulse from '@hcengineering/pulse'

import Workspace from './workspace'
import { getTransactorApiEndpoint, getWorkspaceInfo } from './utils'
import config from './config'

export class Worker {
  private readonly sysHierarchy = new Hierarchy()
  private readonly sysModel = new ModelDb(this.sysHierarchy)

  private readonly workspaces = new Map<WorkspaceUuid, Workspace>()
  private readonly loadingWorkspaces = new Map<WorkspaceUuid, Promise<Workspace | undefined>>()
  private readonly storage: StorageAdapter
  private readonly brandingMap = loadBrandingMap(config.BrandingPath)

  private readonly interval: NodeJS.Timeout | undefined = undefined

  constructor (
    ctx: MeasureContext,
    private readonly modelTxes: Tx[]
  ) {
    // addTxes feeds sysHierarchy itself, a separate pass would just deserialize everything twice.
    this.sysModel.addTxes(ctx, modelTxes, true)

    this.storage = buildStorageFromConfig(storageConfigFrom(config.StorageConfig))

    this.interval = setInterval(
      () => {
        const now = Date.now()
        for (const [uuid, workspace] of Array.from(this.workspaces.entries())) {
          if (workspace.isInProgress()) continue
          const time = workspace.getLastTxDate() ?? 0
          const diff = now - time
          if (diff < 10 * 60 * 1000) continue
          workspace.close().catch((e) => {
            console.error('Error closing workspace', e)
          })
          this.workspaces.delete(uuid)
        }
      },
      5 * 60 * 1000
    )
  }

  async tx (ctx: MeasureContext, ws: WorkspaceUuid, _tx: Tx): Promise<void> {
    if (!TxProcessor.isExtendsCUD(_tx._class)) return

    const tx = _tx as TxCUD<Doc>

    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) return
    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.AppPushNotification)) return
    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.PushSubscription)) return
    if (this.sysHierarchy.isDerived(tx.objectClass, notification.class.ReadState)) return

    if (this.sysHierarchy.isDerived(tx.objectClass, pulse.class.DocumentPresence)) return
    if (this.sysHierarchy.isDerived(tx.objectClass, pulse.class.TypingIndicator)) return
    if (this.sysHierarchy.isDerived(tx.objectClass, pulse.class.WorkspacesNotification)) return

    const domain = this.sysHierarchy.findDomain(tx.objectClass)
    if (domain === DOMAIN_TRANSIENT) return

    const exists = this.workspaces.get(ws)

    if (exists !== undefined) {
      await exists.tx(tx)
      return
    }

    if (this.sysHierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) return
    if (tx.space === core.space.DerivedTx) return

    const loading = this.loadingWorkspaces.get(ws)
    if (loading !== undefined) {
      const resolveWs = await loading
      if (resolveWs !== undefined) {
        await resolveWs.tx(tx)
      }
      return
    }

    const loadWsPromise = this.initWorkspace(ctx, ws, tx)
    this.loadingWorkspaces.set(ws, loadWsPromise)

    try {
      const workspace = await loadWsPromise
      if (workspace !== undefined) {
        await workspace.tx(tx)
      }
    } finally {
      this.loadingWorkspaces.delete(ws)
    }
  }

  private async initWorkspace (
    ctx: MeasureContext,
    ws: WorkspaceUuid,
    initialTx: TxCUD<Doc>
  ): Promise<Workspace | undefined> {
    let wsInfo: (WorkspaceInfoWithStatus & { endpoint: string }) | undefined
    try {
      const token = generateToken(systemAccountUuid, ws, { service: config.ServiceId })
      wsInfo = await getWorkspaceInfo(token)
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
        initialTx.modifiedOn
      )

      this.workspaces.set(ws, workspace)

      return workspace
    } catch (e: any) {
      ctx.error('Failed to connect workspace', wsInfo)
      if (e?.status?.code === platform.status.Forbidden) {
        ctx.error('Workspace is forbidden, dropping workspace initialization', { e, wsUuid: ws })
        return undefined
      }
      throw e
    }
  }

  public close (): void {
    clearInterval(this.interval)
  }
}
