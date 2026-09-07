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

import { TxFactory, toFindResult, type Class, type Doc, type Ref, type TxUpdateDoc } from '@hcengineering/core'
import notification from '@hcengineering/notification'
import { type TriggerControl } from '@hcengineering/server-core'

import { OnDocClassChanged } from '../index'

const oldClass = 'class:Bug' as Ref<Class<Doc>>
const newClass = 'class:Task' as Ref<Class<Doc>>
const objectId = 'issue-1' as Ref<Doc>

const txFactory = new TxFactory('test-account' as any)

function record (_id: string, _class: Ref<Class<Doc>>): Doc {
  return {
    _id,
    _class,
    space: 'person-space',
    objectId,
    objectClass: oldClass,
    modifiedBy: 'user-1',
    modifiedOn: Date.now()
  } as any as Doc
}

function makeControl (found: Partial<Record<string, Doc[]>>): TriggerControl {
  return {
    ctx: { error: jest.fn(), info: jest.fn(), newChild: jest.fn().mockReturnThis() },
    txFactory,
    hierarchy: { isDerived: (a: any, b: any) => a === b },
    findAll: jest.fn().mockImplementation(async (_ctx, _class) => toFindResult(found[_class as string] ?? []))
  } as any as TriggerControl
}

function classChangeTx (): TxUpdateDoc<Doc> {
  const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, {
    kind: 'task'
  } as any)
  ;(tx.operations as any)._class = newClass
  return tx
}

describe('OnDocClassChanged (notification)', () => {
  it('repoints the notify context and the inbox notifications', async () => {
    const control = makeControl({
      [notification.class.DocNotifyContext]: [record('ctx-1', notification.class.DocNotifyContext)],
      [notification.class.InboxNotification]: [record('inbox-1', notification.class.InboxNotification)]
    })

    const result = (await OnDocClassChanged([classChangeTx()], control)) as TxUpdateDoc<Doc>[]

    expect(result).toHaveLength(2)
    expect(result.map((it) => it.objectId).sort()).toEqual(['ctx-1', 'inbox-1'])
    for (const tx of result) {
      expect((tx.operations as any).objectClass).toBe(newClass)
    }
  })

  it('ignores updates that do not carry a class', async () => {
    const control = makeControl({
      [notification.class.DocNotifyContext]: [record('ctx-1', notification.class.DocNotifyContext)]
    })
    const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, { title: 'x' } as any)

    expect(await OnDocClassChanged([tx], control)).toEqual([])
  })

  it('ignores a class that repeats the one the document already has', async () => {
    const control = makeControl({
      [notification.class.DocNotifyContext]: [record('ctx-1', notification.class.DocNotifyContext)]
    })
    const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, {} as any)
    ;(tx.operations as any)._class = oldClass

    expect(await OnDocClassChanged([tx], control)).toEqual([])
  })

  it('emits nothing when the document has no notification records', async () => {
    expect(await OnDocClassChanged([classChangeTx()], makeControl({}))).toEqual([])
  })
})
