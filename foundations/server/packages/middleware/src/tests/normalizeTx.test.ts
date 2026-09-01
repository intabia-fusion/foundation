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

import core, {
  type Account,
  AccountRole,
  type Class,
  type Doc,
  MeasureMetricsContext,
  type Ref,
  type Space,
  systemAccountUuid,
  TxFactory
} from '@hcengineering/core'
import { type Middleware, type PipelineContext } from '@hcengineering/server-core'
import { NormalizeTxMiddleware } from '../normalizeTx'

describe('NormalizeTxMiddleware', () => {
  const ctx = new MeasureMetricsContext('test', {})
  const factory = new TxFactory('system' as any)

  const systemAccount = {
    uuid: systemAccountUuid,
    role: AccountRole.Owner
  } as unknown as Account

  const userAccount = {
    uuid: 'user-acc-uuid',
    role: AccountRole.User
  } as unknown as Account

  function createPipelineContext (): PipelineContext {
    return {} as unknown as PipelineContext
  }

  it('keeps silent flag for system account', async () => {
    let capturedTxes: any[] = []
    const nextMiddleware = {
      tx: async (_ctx: any, txes: any) => {
        capturedTxes = txes as any[]
        return { txes: txes as any[] }
      }
    } as unknown as Middleware

    const middleware = await NormalizeTxMiddleware.create(ctx, createPipelineContext(), nextMiddleware)
    const tx = factory.createTxCreateDoc(
      'class:Test' as Ref<Class<Doc>>,
      'space:Test' as Ref<Space>,
      {},
      undefined,
      undefined,
      undefined,
      { silent: true }
    )

    const sessionCtx: any = {
      ...ctx,
      contextData: { account: systemAccount }
    }

    await middleware.tx(sessionCtx, [tx])
    expect(capturedTxes[0].meta?.silent).toBe(true)
  })

  it('strips silent flag for non-system user account', async () => {
    let capturedTxes: any[] = []
    const nextMiddleware = {
      tx: async (_ctx: any, txes: any) => {
        capturedTxes = txes as any[]
        return { txes: txes as any[] }
      }
    } as unknown as Middleware

    const middleware = await NormalizeTxMiddleware.create(ctx, createPipelineContext(), nextMiddleware)
    const tx = factory.createTxCreateDoc(
      'class:Test' as Ref<Class<Doc>>,
      'space:Test' as Ref<Space>,
      {},
      undefined,
      undefined,
      undefined,
      { silent: true, foo: 'bar' }
    )

    const sessionCtx: any = {
      ...ctx,
      contextData: { account: userAccount }
    }

    await middleware.tx(sessionCtx, [tx])
    expect(capturedTxes[0].meta?.silent).toBeUndefined()
    expect(capturedTxes[0].meta?.foo).toBe('bar')
  })

  // JSON has no undefined, so an optional field of a json client arrives as null.
  describe('null in optional fields (json protocol)', () => {
    async function run (raw: any): Promise<any> {
      let captured: any[] = []
      const next = {
        tx: async (_ctx: any, txes: any) => {
          captured = txes as any[]
          return { txes: txes as any[] }
        }
      } as unknown as Middleware
      const middleware = await NormalizeTxMiddleware.create(ctx, createPipelineContext(), next)
      await middleware.tx({ ...ctx, contextData: { account: systemAccount } } as any, [raw])
      return captured[0]
    }

    const base = {
      _id: 'tx1',
      space: 'core:space:Tx',
      modifiedBy: 'core:account:System',
      modifiedOn: 1,
      objectSpace: 'core:space:Model',
      createdBy: null,
      createdOn: null,
      meta: null
    }
    const cud = {
      objectId: 'obj1',
      objectClass: 'class:Test',
      attachedTo: null,
      attachedToClass: null,
      collection: null
    }

    it('accepts TxUpdateDoc and normalizes every null to undefined', async () => {
      const out = await run({ ...base, ...cud, _class: core.class.TxUpdateDoc, operations: { a: 1 }, retrieve: null })
      for (const key of ['createdBy', 'createdOn', 'meta', 'attachedTo', 'attachedToClass', 'collection', 'retrieve']) {
        expect(out[key]).toBeUndefined()
        expect(out[key]).not.toBeNull()
      }
      expect(out.operations).toEqual({ a: 1 })
    })

    it('accepts TxCreateDoc and TxRemoveDoc', async () => {
      const created = await run({ ...base, ...cud, _class: core.class.TxCreateDoc, attributes: {} })
      expect(created.attributes).toEqual({})
      expect(created.attachedTo).toBeUndefined()

      const removed = await run({ ...base, ...cud, _class: core.class.TxRemoveDoc, removedDoc: null })
      expect(removed.removedDoc).toBeUndefined()
    })

    it('accepts TxApplyIf with null optionals', async () => {
      const out = await run({
        ...base,
        _class: core.class.TxApplyIf,
        scope: null,
        match: null,
        notMatch: null,
        notify: null,
        extraNotify: null,
        measureName: null,
        txes: [{ ...base, ...cud, _class: core.class.TxUpdateDoc, operations: {}, retrieve: null }]
      })
      for (const key of ['scope', 'match', 'notMatch', 'notify', 'extraNotify', 'measureName']) {
        expect(out[key]).toBeUndefined()
      }
      expect(out.txes).toHaveLength(1)
      expect(out.txes[0].retrieve).toBeUndefined()
    })

    it('still rejects null in required fields', async () => {
      const cases = [
        { ...base, ...cud, _class: core.class.TxUpdateDoc, operations: null, retrieve: null },
        { ...base, ...cud, objectId: null, _class: core.class.TxUpdateDoc, operations: {} },
        { ...base, ...cud, objectClass: null, _class: core.class.TxUpdateDoc, operations: {} },
        { ...base, ...cud, _class: core.class.TxCreateDoc, attributes: null },
        { ...base, ...cud, _class: core.class.TxMixin, mixin: null, attributes: {} },
        { ...base, _class: core.class.TxApplyIf, txes: null },
        { ...base, ...cud, modifiedBy: null, _class: core.class.TxUpdateDoc, operations: {} }
      ]
      for (const raw of cases) {
        await expect(run(raw)).rejects.toThrow()
      }
    })

    it('rejects a wrong type where null is now allowed', async () => {
      await expect(
        run({ ...base, ...cud, _class: core.class.TxUpdateDoc, operations: {}, retrieve: 'yes' })
      ).rejects.toThrow()
      await expect(
        run({ ...base, ...cud, _class: core.class.TxUpdateDoc, operations: {}, collection: 5 })
      ).rejects.toThrow()
    })
  })
})
