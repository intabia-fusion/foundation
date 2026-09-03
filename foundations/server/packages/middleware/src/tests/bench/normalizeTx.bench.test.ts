//
// Copyright © 2026 Intabia Fusion
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
  type AccountUuid,
  type Doc,
  generateId,
  type Ref,
  type Space,
  type Tx,
  TxFactory
} from '@hcengineering/core'
import type { Middleware } from '@hcengineering/server-core'
import { NormalizeTxMiddleware } from '../../normalizeTx'
import { bench, describeBench } from '@hcengineering/measurements'
import { createHarness, makeNextMiddleware } from './harness'

describeBench('NormalizeTxMiddleware bench', () => {
  const factory = new TxFactory(core.account.System)
  const objClass = 'bench:class:Item' as Ref<any>
  const space = 'bench:space:S' as Ref<Space>
  const acc = 'u1' as AccountUuid

  function buildCreate (): Tx {
    return factory.createTxCreateDoc(objClass, space, {
      name: 'item',
      counter: 1,
      tags: ['a', 'b', 'c']
    } as any)
  }
  function buildUpdate (): Tx {
    return factory.createTxUpdateDoc(objClass, space, generateId<Doc>(), {
      counter: 2,
      name: 'upd'
    } as any)
  }
  function buildRemove (): Tx {
    return factory.createTxRemoveDoc(objClass, space, generateId<Doc>())
  }
  function buildApplyIf (n: number): Tx {
    const txes: Tx[] = []
    for (let i = 0; i < n; i++) txes.push(buildCreate())
    return factory.createTxApplyIf(space, 'scope-' + n, [], [], txes as any, 'bench')
  }

  async function setup (): Promise<NormalizeTxMiddleware> {
    void acc
    const h = createHarness()
    const next = makeNextMiddleware(h, { tx: async () => ({}) })
    return await NormalizeTxMiddleware.create(h.ctx, h.pipelineContext, next as unknown as Middleware)
  }

  it('createDoc throughput', async () => {
    const mw = await setup()
    const tx = buildCreate()
    const ctx = (mw as any).context.contextVars // unused, just keep mw alive
    void ctx
    await bench('normalizeTx createDoc x1', async () => {
      await mw.tx({} as any, [tx])
    })
  })

  it('updateDoc throughput', async () => {
    const mw = await setup()
    const tx = buildUpdate()
    await bench('normalizeTx updateDoc x1', async () => {
      await mw.tx({} as any, [tx])
    })
  })

  it('removeDoc throughput', async () => {
    const mw = await setup()
    const tx = buildRemove()
    await bench('normalizeTx removeDoc x1', async () => {
      await mw.tx({} as any, [tx])
    })
  })

  it('mixed batch (10 tx)', async () => {
    const mw = await setup()
    const txes: Tx[] = []
    for (let i = 0; i < 10; i++) {
      txes.push(i % 3 === 0 ? buildCreate() : i % 3 === 1 ? buildUpdate() : buildRemove())
    }
    await bench('normalizeTx mixed batch x10', async () => {
      await mw.tx({} as any, txes)
    })
  })

  it('applyIf wrap (20 children)', async () => {
    const mw = await setup()
    const tx = buildApplyIf(20)
    await bench('normalizeTx applyIf x20', async () => {
      await mw.tx({} as any, [tx])
    })
  })
})
