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
  ClassifierKind,
  DOMAIN_MODEL,
  Hierarchy,
  MeasureMetricsContext,
  ModelDb,
  TxFactory,
  type Class,
  type Data,
  type Doc,
  type DocumentQuery,
  type Obj,
  type Ref,
  type Tx
} from '@hcengineering/core'
import { addLocation } from '@hcengineering/platform'
import { Triggers } from '../triggers'
import serverCore, { serverCoreId } from '../plugin'
import type { TriggerControl } from '../types'

const ctx = new MeasureMetricsContext('test', {})
const factory = new TxFactory(core.account.System)

const BASE = 'test:class:Base' as Ref<Class<Doc>>
const DERIVED = 'test:class:Derived' as Ref<Class<Doc>>

function classTx (_id: Ref<Class<Obj>>, ext: Ref<Class<Obj>> | undefined): Tx {
  return factory.createTxCreateDoc(
    core.class.Class,
    core.space.Model,
    { kind: ClassifierKind.CLASS, extends: ext, label: 'x', domain: DOMAIN_MODEL } as unknown as Data<Class<Obj>>,
    _id
  )
}

describe('Triggers', () => {
  it('does not expand txMatch inside the shared model document', async () => {
    addLocation(serverCoreId, async () => ({ default: async () => ({ trigger: { OnTrigger: async () => [] } }) }))

    const h = new Hierarchy()
    const db = new ModelDb(h)
    const txMatch: DocumentQuery<Tx> = { objectClass: BASE }
    db.addTxes(
      ctx,
      [
        classTx(core.class.Obj, undefined),
        classTx(core.class.Doc, core.class.Obj),
        classTx(core.class.Class, core.class.Doc),
        classTx(core.class.Tx, core.class.Doc),
        classTx(core.class.TxCUD, core.class.Tx),
        classTx(core.class.TxCreateDoc, core.class.TxCUD),
        classTx(serverCore.class.Trigger, core.class.Doc),
        classTx(BASE, core.class.Doc),
        classTx(DERIVED, BASE),
        factory.createTxCreateDoc(serverCore.class.Trigger, core.space.Model, {
          trigger: `${serverCoreId}:trigger:OnTrigger` as any,
          txMatch
        })
      ],
      true
    )
    // Shared model: a workspace must not be able to write into it.
    db.freeze()

    const triggers = new Triggers(h)
    triggers.init(db)
    const control = {
      hierarchy: h,
      modelDb: db,
      txes: [],
      workspace: { uuid: 'ws' },
      apply: async () => ({})
    } as unknown as Omit<TriggerControl, 'txFactory'>
    const tx = factory.createTxCreateDoc(DERIVED, core.space.Model, {})

    // Expanding the query used to write $in back into the frozen trigger document.
    await triggers.apply(ctx, [tx], control, 'sync')

    const stored = db.findAllSync(serverCore.class.Trigger, {})[0] as any
    expect(stored.txMatch.objectClass).toBe(BASE)
  })
})
