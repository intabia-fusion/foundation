//
// Copyright © 2025 Hardcore Engineering Inc.
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
import core, {
  type Class,
  type Doc,
  type MeasureContext,
  type Mixin,
  type OperationDomain,
  type PersonId,
  type Ref,
  type SessionData,
  type Space,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxDomainEvent,
  type TxMixin,
  type TxModelUpgrade,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc,
  type TxWorkspaceEvent
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import { isSystem } from './utils'

// Helper types to require update in validation after Tx types are changed
type ExplicitUndefined<T> = { [P in keyof Required<T>]: Exclude<T[P], undefined> | Extract<T[P], undefined> }
type WithIdType<T, I> = Omit<T, '_id'> & { _id: I }
type ExplicitTx<T> = WithIdType<ExplicitUndefined<T>, Ref<Tx>>

/**
 * Validates properties in known Tx interfaces and removes unrecognized properties
 * @public
 */
export class NormalizeTxMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<NormalizeTxMiddleware> {
    return new NormalizeTxMiddleware(context, next)
  }

  tx (ctx: MeasureContext<SessionData>, txes: unknown[]): Promise<TxMiddlewareResult> {
    const isSystemAccount = isSystem(ctx.contextData.account, ctx)
    const parsedTxes = []
    for (const tx of txes) {
      const parsedTx = this.parseTx(tx)
      if (parsedTx === undefined) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, {}))
      }
      this.sanitizeTxMeta(parsedTx, isSystemAccount)
      parsedTxes.push(parsedTx)
    }
    return this.provideTx(ctx, parsedTxes)
  }

  private sanitizeTxMeta (tx: Tx, isSystemAccount: boolean): void {
    if (!isSystemAccount && tx.meta?.silent !== undefined) {
      delete tx.meta.silent
    }
    if (tx._class === core.class.TxApplyIf) {
      const applyIf = tx as TxApplyIf
      if (Array.isArray(applyIf.txes)) {
        for (const childTx of applyIf.txes) {
          this.sanitizeTxMeta(childTx, isSystemAccount)
        }
      }
    }
  }

  private checkMeta (meta: unknown): meta is Record<string, string | number | boolean> | undefined {
    // json cannot carry undefined, so an optional field arrives as null - same meaning here.
    if (meta == null) {
      return true
    }
    if (typeof meta !== 'object') {
      return false
    }
    for (const [, val] of Object.entries(meta)) {
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
        return false
      }
    }
    return true
  }

  private parseBaseTx (source: unknown): ExplicitTx<Tx> | undefined {
    if (source == null || typeof source !== 'object') {
      return undefined
    }
    const { _class, _id, space, modifiedBy, modifiedOn, createdBy, createdOn, objectSpace, meta } = source as Record<
    keyof Tx,
    unknown
    >
    const isTxValid =
      typeof _class === 'string' &&
      typeof _id === 'string' &&
      typeof space === 'string' &&
      typeof modifiedBy === 'string' &&
      typeof modifiedOn === 'number' &&
      (createdBy == null || typeof createdBy === 'string') &&
      (createdOn == null || typeof createdOn === 'number') &&
      typeof objectSpace === 'string' &&
      this.checkMeta(meta)
    if (!isTxValid) {
      return undefined
    }
    const baseTx: ExplicitTx<Tx> = {
      _class: _class as Ref<Class<Doc>>,
      _id: _id as Ref<Tx>,
      space: space as Ref<Space>,
      modifiedBy: modifiedBy as PersonId,
      modifiedOn,
      createdBy: (createdBy ?? undefined) as PersonId | undefined,
      createdOn: createdOn ?? undefined,
      objectSpace: objectSpace as Ref<Space>,
      meta: (meta ?? undefined) as Record<string, any> | undefined
    }
    return baseTx
  }

  private parseTx (source: unknown): Tx | undefined {
    const baseTx = this.parseBaseTx(source)
    if (baseTx === undefined) {
      return undefined
    }

    if (TxProcessor.isExtendsCUD(baseTx._class)) {
      return this.parseTxCUD(source, baseTx)
    } else if (baseTx._class === core.class.TxWorkspaceEvent) {
      const { event, params } = source as any
      if (typeof event !== 'number') {
        return undefined
      }
      const workspaceEvent: ExplicitTx<TxWorkspaceEvent> = Object.assign(baseTx, {
        event,
        params
      })
      return workspaceEvent
    } else if (baseTx._class === core.class.TxDomainEvent) {
      const { domain, event } = source as any
      if (typeof domain !== 'string') {
        return undefined
      }
      const domainEvent: ExplicitTx<TxDomainEvent> = Object.assign(baseTx, {
        domain: domain as OperationDomain,
        event
      })
      return domainEvent
    } else if (baseTx._class === core.class.TxApplyIf) {
      const { scope, match, notMatch, txes, notify, extraNotify, measureName } = source as Record<
      keyof TxApplyIf,
      unknown
      >
      const isValid =
        (scope == null || typeof scope === 'string') &&
        (match == null || Array.isArray(match)) &&
        (notMatch == null || Array.isArray(notMatch)) &&
        Array.isArray(txes) &&
        (notify == null || typeof notify === 'boolean') &&
        (extraNotify == null || Array.isArray(extraNotify)) &&
        (measureName == null || typeof measureName === 'string')
      if (!isValid) {
        return undefined
      }
      const parsedTxes: TxCUD<Doc>[] = []
      for (const tx of txes) {
        const baseChildTx = this.parseBaseTx(tx)
        if (baseChildTx === undefined || !TxProcessor.isExtendsCUD(baseChildTx._class)) {
          return undefined
        }
        const parsed = this.parseTxCUD(tx, baseChildTx)
        if (parsed === undefined) {
          return undefined
        }
        parsedTxes.push(parsed as TxCUD<Doc>)
      }
      const applyIf: ExplicitTx<TxApplyIf> = Object.assign(baseTx, {
        scope: scope ?? undefined,
        match: match ?? undefined,
        notMatch: notMatch ?? undefined,
        txes: parsedTxes,
        notify: notify ?? undefined,
        extraNotify: extraNotify ?? undefined,
        measureName: measureName ?? undefined
      })
      return applyIf
    } else if (baseTx._class === core.class.TxModelUpgrade) {
      const modelUpgrade: TxModelUpgrade = baseTx
      return modelUpgrade
    }

    return undefined
  }

  private parseTxCUD (source: unknown, base: ExplicitTx<Tx>): ExplicitTx<TxCUD<Doc>> | undefined {
    const { objectId, objectClass, attachedTo, attachedToClass, collection } = source as Record<
    keyof TxCUD<Doc>,
    unknown
    >
    const isValid =
      typeof objectId === 'string' &&
      typeof objectClass === 'string' &&
      (attachedTo == null || typeof attachedTo === 'string') &&
      (attachedToClass == null || typeof attachedToClass === 'string') &&
      (collection == null || typeof collection === 'string')
    if (!isValid) {
      return undefined
    }
    const baseCUD: ExplicitTx<TxCUD<Doc>> = Object.assign(base, {
      objectId: objectId as Ref<Doc>,
      objectClass: objectClass as Ref<Class<Doc>>,
      attachedTo: (attachedTo ?? undefined) as Ref<Doc>,
      attachedToClass: (attachedToClass ?? undefined) as Ref<Class<Doc>>,
      collection: collection ?? undefined
    })
    if (baseCUD._class === core.class.TxCreateDoc) {
      const { attributes } = source as Record<keyof TxCreateDoc<Doc>, unknown>
      if (typeof attributes !== 'object' || attributes === null) {
        return undefined
      }
      const createDoc: ExplicitTx<TxCreateDoc<Doc>> = Object.assign(baseCUD, { attributes })
      return createDoc
    } else if (baseCUD._class === core.class.TxUpdateDoc) {
      const { operations, retrieve } = source as Record<keyof TxUpdateDoc<Doc>, unknown>
      if (
        typeof operations !== 'object' ||
        operations === null ||
        (retrieve != null && typeof retrieve !== 'boolean')
      ) {
        return undefined
      }
      const updateDoc: ExplicitTx<TxUpdateDoc<Doc>> = Object.assign(baseCUD, {
        operations,
        retrieve: retrieve ?? undefined
      })
      return updateDoc
    } else if (baseCUD._class === core.class.TxRemoveDoc) {
      const { removedDoc } = source as Record<keyof TxRemoveDoc<Doc>, unknown>

      return Object.assign(baseCUD, {
        removedDoc: (removedDoc ?? undefined) as Doc | undefined
      })
    } else if (baseCUD._class === core.class.TxMixin) {
      const { mixin, attributes } = source as Record<keyof TxMixin<Doc, Doc>, unknown>
      if (typeof mixin !== 'string' || typeof attributes !== 'object' || attributes === null) {
        return undefined
      }
      const txMixin: ExplicitTx<TxMixin<Doc, Doc>> = Object.assign(baseCUD, {
        mixin: mixin as Ref<Mixin<Doc>>,
        attributes
      })
      return txMixin
    } else {
      return undefined
    }
  }
}
