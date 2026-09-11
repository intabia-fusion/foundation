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

import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import core, {
  type Doc,
  Tx,
  type TxCreateDoc,
  type TxCUD,
  TxProcessor,
  type TxUpdateDoc,
  MeasureContext,
  Ref,
  type SessionData,
  systemAccountUuid,
  TxFactory
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import notification, { ReadState } from '@hcengineering/notification'
import chunter, { ThreadMessage } from '@hcengineering/chunter'
import pulse, { WorkspacesNotification } from '@hcengineering/pulse'
import contact from '@hcengineering/contact'

export class NotificationMiddleware extends BaseMiddleware {
  private readonly activeStates = new Map<Ref<ReadState>, ReadState>()
  private intervalId: number | null = null

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)

    // // Clear if no updates 10 minutes, check every 20 minutes
    this.intervalId = setInterval(
      () => {
        const now = Date.now()
        for (const [key, value] of this.activeStates) {
          if (value.modifiedOn < now - 10 * 60 * 1000) {
            this.activeStates.delete(key)
          }
        }
      },
      20 * 60 * 1000
    )
  }

  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    return new NotificationMiddleware(context, next)
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const skip: Ref<Tx>[] = []
    for (const _tx of txes) {
      if (!TxProcessor.isExtendsCUD(_tx._class)) continue
      const tx = _tx as TxCUD<Doc>

      this.handleDocNotifyContext(ctx, tx)
      this.handleAppPushNotification(ctx, tx)

      const apply = await this.handleReadState(ctx, tx)
      if (!apply) skip.push(_tx._id)

      if (tx._class === core.class.TxCreateDoc && tx.objectClass === pulse.class.WorkspacesNotification) {
        const createTx = tx as TxCreateDoc<WorkspacesNotification>
        const accountId = createTx.attributes?.account
        if (accountId != null) {
          const space = (await this.findAll(ctx, contact.class.PersonSpace, { account: accountId }))[0]
          if (space != null) {
            createTx.objectSpace = space._id
          }
        }
      }
    }

    const nextTxes = skip.length > 0 ? txes.filter((tx) => !skip.includes(tx._id)) : txes
    if (nextTxes.length === 0) {
      return {}
    }
    return await this.provideTx(ctx, nextTxes)
  }

  private isSystemAccess (ctx: MeasureContext<SessionData>): boolean {
    const account = ctx.contextData.account
    return account.uuid === systemAccountUuid || ctx.contextData.isTriggerCtx === true
  }

  private handleDocNotifyContext (ctx: MeasureContext<SessionData>, tx: TxCUD<Doc>): void {
    if (tx.objectClass === notification.class.DocNotifyContext) {
      if (tx._class === core.class.TxCreateDoc || tx._class === core.class.TxUpdateDoc) {
        if (!this.isSystemAccess(ctx)) {
          this.throwForbidden()
        }
      }
    }
  }

  private handleAppPushNotification (ctx: MeasureContext<SessionData>, tx: TxCUD<Doc>): void {
    if (tx.objectClass === notification.class.AppPushNotification) {
      if (tx._class === core.class.TxCreateDoc || tx._class === core.class.TxUpdateDoc) {
        if (!this.isSystemAccess(ctx)) {
          this.throwForbidden()
        }
      }
    }
  }

  private async handleReadState (ctx: MeasureContext<SessionData>, tx: TxCUD<Doc>): Promise<boolean> {
    const account = ctx.contextData.account
    const factory = new TxFactory(core.account.System, true)

    if (tx._class === core.class.TxCreateDoc && tx.objectClass === notification.class.ReadState) {
      if (!this.isSystemAccess(ctx)) {
        this.throwForbidden()
      }
      const createTx = tx as TxCreateDoc<ReadState>
      const state = TxProcessor.createDoc2Doc(createTx)
      this.activeStates.set(state._id, state)
    } else if (tx._class === core.class.TxCreateDoc && tx.objectClass === chunter.class.ThreadMessage) {
      const createTx = tx as TxCreateDoc<ThreadMessage>
      const message = TxProcessor.createDoc2Doc(createTx)

      const attachedTo = message.attachedTo
      const attachedToClass = message.attachedToClass
      const state = await this.getStateByDoc(ctx, attachedTo)
      if (state == null) {
        const ttx = factory.createTxCreateDoc(notification.class.ReadState, message.space, {
          attachedTo,
          attachedToClass,
          collection: 'readStates'
        })
        const systemCtx = Object.create(ctx)
        systemCtx.contextData = Object.create(ctx.contextData)
        systemCtx.contextData.isTriggerCtx = true
        await this.context.derived?.tx(systemCtx, [ttx])
      }
    } else if (tx._class === core.class.TxUpdateDoc && tx.objectClass === notification.class.ReadState) {
      if (this.isSystemAccess(ctx)) return true

      const updateTx = tx as TxUpdateDoc<ReadState>
      if (
        updateTx.operations[account.uuid]?.timestamp == null ||
        updateTx.operations[account.uuid]?.messageId == null
      ) {
        this.throwForbidden()
      }

      const state = await this.getState(ctx, updateTx.objectId)
      if (state != null) {
        updateTx.operations = {
          [account.uuid]: updateTx.operations[account.uuid]
        }

        const currentTimestamp = state[account.uuid]?.timestamp ?? 0
        const updateTimestamp = updateTx.operations[account.uuid]?.timestamp ?? 0

        if (currentTimestamp > updateTimestamp) return false

        this.activeStates.set(state._id, TxProcessor.updateDoc2Doc(state, updateTx))
      }
    } else if (tx._class === core.class.TxRemoveDoc && tx.objectClass === notification.class.ReadState) {
      if (!this.isSystemAccess(ctx)) {
        this.throwForbidden()
      }
      this.activeStates.delete(tx.objectId as Ref<ReadState>)
    }

    return true
  }

  private async getState (ctx: MeasureContext<SessionData>, _id: Ref<ReadState>): Promise<ReadState | undefined> {
    const current = this.activeStates.get(_id)
    if (current != null) {
      return current
    }

    const state = (await this.findAll(ctx, notification.class.ReadState, { _id }))[0]
    if (state != null) {
      this.activeStates.set(state._id, state)
      return state
    }

    return undefined
  }

  private async getStateByDoc (ctx: MeasureContext<SessionData>, attachedTo: Ref<Doc>): Promise<ReadState | undefined> {
    const current = Array.from(this.activeStates.values()).find((state) => state.attachedTo === attachedTo)

    if (current != null) {
      return current
    }

    const state = (await this.findAll(ctx, notification.class.ReadState, { attachedTo }))[0]
    if (state != null) {
      this.activeStates.set(state._id, state)
      return state
    }

    return undefined
  }

  private throwForbidden (): void {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }

  async close (): Promise<void> {
    if (this.intervalId != null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
