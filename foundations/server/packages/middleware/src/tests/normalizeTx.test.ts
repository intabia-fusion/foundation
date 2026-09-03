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
})
