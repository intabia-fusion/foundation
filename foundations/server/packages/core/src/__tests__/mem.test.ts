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
  type Class,
  ClassifierKind,
  type Doc,
  DOMAIN_TRANSIENT,
  generateId,
  Hierarchy,
  MeasureMetricsContext,
  type Ref,
  type Space,
  TxFactory,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import type { DbAdapter } from '../adapter'
import { createInMemoryAdapter } from '../mem'

interface TransientDoc extends Doc {
  payload: string
}

const transientClass = 'test:class:Transient' as Ref<Class<TransientDoc>>
const transientSpace = 'test:space:Transient' as Ref<Space>

const txFactory = new TxFactory(core.account.System)

async function seedDoc (adapter: DbAdapter, ctx: MeasureMetricsContext, payload: string): Promise<Ref<TransientDoc>> {
  const id = generateId<TransientDoc>()
  const tx = txFactory.createTxCreateDoc(transientClass, transientSpace, { payload }, id)
  await adapter.tx(ctx, tx)
  return id
}

async function createAdapter (): Promise<DbAdapter> {
  const ctx = new MeasureMetricsContext('test', {})
  const hierarchy = new Hierarchy()

  // Register minimal hierarchy: Obj -> Doc -> transientClass.
  hierarchy.tx(
    txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Obj' as IntlString, kind: ClassifierKind.CLASS },
      core.class.Obj
    )
  )
  hierarchy.tx(
    txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Doc' as IntlString, extends: core.class.Obj, kind: ClassifierKind.CLASS },
      core.class.Doc
    )
  )
  hierarchy.tx(
    txFactory.createTxCreateDoc(
      core.class.Class,
      core.space.Model,
      { label: 'Transient' as IntlString, extends: core.class.Doc, kind: ClassifierKind.CLASS },
      transientClass
    )
  )

  const ws: WorkspaceIds = {
    uuid: 'test-ws' as WorkspaceUuid,
    url: 'test',
    dataId: 'test' as any
  }
  return await createInMemoryAdapter(ctx, hierarchy, '', ws)
}

describe('InMemoryAdapter.clean', () => {
  it('removes documents so subsequent findAll/load return empty', async () => {
    const adapter = await createAdapter()
    const ctx = new MeasureMetricsContext('test', {})

    const id1 = await seedDoc(adapter, ctx, 'a')
    const id2 = await seedDoc(adapter, ctx, 'b')

    const beforeLoad = await adapter.load(ctx, DOMAIN_TRANSIENT, [id1, id2])
    expect(beforeLoad).toHaveLength(2)

    const beforeFind = await adapter.findAll(ctx, transientClass, {})
    expect(beforeFind).toHaveLength(2)

    await adapter.clean(ctx, DOMAIN_TRANSIENT, [id1])

    const afterLoad = await adapter.load(ctx, DOMAIN_TRANSIENT, [id1, id2])
    expect(afterLoad).toHaveLength(1)
    expect((afterLoad[0] as TransientDoc).payload).toBe('b')

    const afterFind = await adapter.findAll(ctx, transientClass, {})
    expect(afterFind).toHaveLength(1)
    expect((afterFind[0] as TransientDoc).payload).toBe('b')
  })

  it('removes only known ids and ignores unknown ones', async () => {
    const adapter = await createAdapter()
    const ctx = new MeasureMetricsContext('test', {})

    const id1 = await seedDoc(adapter, ctx, 'a')

    const missing = generateId<TransientDoc>()
    await expect(adapter.clean(ctx, DOMAIN_TRANSIENT, [missing, id1])).resolves.toBeUndefined()

    const afterLoad = await adapter.load(ctx, DOMAIN_TRANSIENT, [id1])
    expect(afterLoad).toHaveLength(0)
  })

  it('cleans all documents when given full id list', async () => {
    const adapter = await createAdapter()
    const ctx = new MeasureMetricsContext('test', {})

    const ids = [await seedDoc(adapter, ctx, 'a'), await seedDoc(adapter, ctx, 'b'), await seedDoc(adapter, ctx, 'c')]

    await adapter.clean(ctx, DOMAIN_TRANSIENT, ids)

    const findAll = await adapter.findAll(ctx, transientClass, {})
    expect(findAll).toHaveLength(0)
  })

  it('handles empty id list', async () => {
    const adapter = await createAdapter()
    const ctx = new MeasureMetricsContext('test', {})

    await seedDoc(adapter, ctx, 'a')

    await adapter.clean(ctx, DOMAIN_TRANSIENT, [])

    const findAll = await adapter.findAll(ctx, transientClass, {})
    expect(findAll).toHaveLength(1)
  })
})
