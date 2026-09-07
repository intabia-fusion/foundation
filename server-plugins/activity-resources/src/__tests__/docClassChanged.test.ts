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

import activity from '@hcengineering/activity'
import {
  TxFactory,
  toFindResult,
  type Class,
  type Doc,
  type Ref,
  type TxCUD,
  type TxUpdateDoc
} from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'

import { OnDocClassChanged } from '../index'

const oldClass = 'class:Bug' as Ref<Class<Doc>>
const newClass = 'class:Task' as Ref<Class<Doc>>
const objectId = 'issue-1' as Ref<Doc>

const txFactory = new TxFactory('test-account' as any)

function makeControl (messages: Doc[]): TriggerControl {
  return {
    ctx: { error: jest.fn(), info: jest.fn(), newChild: jest.fn().mockReturnThis() },
    txFactory,
    hierarchy: { isDerived: (a: any, b: any) => a === b },
    findAll: jest.fn().mockImplementation(async (_ctx, _class) => {
      return _class === activity.class.ActivityMessage ? toFindResult(messages) : toFindResult([])
    })
  } as any as TriggerControl
}

function makeMessage (over: Record<string, any> = {}): Doc {
  return {
    _id: 'msg-1',
    _class: activity.class.DocUpdateMessage,
    space: 'space-1',
    attachedTo: objectId,
    attachedToClass: oldClass,
    objectId,
    objectClass: oldClass,
    modifiedBy: 'user-1',
    modifiedOn: Date.now(),
    ...over
  } as any as Doc
}

function classChangeTx (): TxCUD<Doc> {
  const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, {
    kind: 'task'
  } as any)
  ;(tx.operations as any)._class = newClass
  return tx
}

describe('OnDocClassChanged (activity)', () => {
  it('repoints the activity messages of a document that changed class', async () => {
    const control = makeControl([makeMessage()])

    const result = (await OnDocClassChanged([classChangeTx()], control)) as TxUpdateDoc<Doc>[]

    expect(result).toHaveLength(1)
    expect((result[0].operations as any).attachedToClass).toBe(newClass)
    expect((result[0].operations as any).objectClass).toBe(newClass)
  })

  it('ignores updates that do not carry a class', async () => {
    const control = makeControl([makeMessage()])
    const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, { title: 'x' } as any)

    expect(await OnDocClassChanged([tx as TxCUD<Doc>], control)).toEqual([])
  })

  it('ignores a class that repeats the one the document already has', async () => {
    const control = makeControl([makeMessage()])
    const tx = txFactory.createTxUpdateDoc(oldClass, 'space-1' as any, objectId, {} as any)
    ;(tx.operations as any)._class = oldClass

    expect(await OnDocClassChanged([tx as TxCUD<Doc>], control)).toEqual([])
  })

  it('leaves alone a message that already points at the new class', async () => {
    const control = makeControl([makeMessage({ attachedToClass: newClass, objectClass: newClass })])

    expect(await OnDocClassChanged([classChangeTx()], control)).toEqual([])
  })

  it('ignores transactions that are not updates', async () => {
    const control = makeControl([makeMessage()])
    const tx = txFactory.createTxRemoveDoc(oldClass, 'space-1' as any, objectId)

    expect(await OnDocClassChanged([tx as TxCUD<Doc>], control)).toEqual([])
  })
})
