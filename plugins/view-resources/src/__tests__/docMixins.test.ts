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
import core, {
  ClassifierKind,
  DOMAIN_MODEL,
  Hierarchy,
  TxFactory,
  type Class,
  type Data,
  type Doc,
  type Mixin,
  type Obj,
  type Rank,
  type Ref
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import { filterDocMixins } from '../docMixins'

const test = {
  class: {
    Task: 'test:class:Task' as Ref<Class<Doc>>,
    Other: 'test:class:Other' as Ref<Class<Doc>>
  },
  mixin: {
    OnDoc: 'test:mixin:OnDoc' as Ref<Mixin<Doc>>,
    OnTask: 'test:mixin:OnTask' as Ref<Mixin<Doc>>,
    OnOther: 'test:mixin:OnOther' as Ref<Mixin<Doc>>,
    ChildOfOnTask: 'test:mixin:ChildOfOnTask' as Ref<Mixin<Doc>>,
    Ignored: 'test:mixin:Ignored' as Ref<Mixin<Doc>>
  }
}

const txFactory = new TxFactory(core.account.System)

function classTx (_class: Ref<Class<Obj>>, attributes: Data<Class<Obj>>): any {
  return txFactory.createTxCreateDoc(core.class.Class, core.space.Model, attributes, _class)
}

function cls (_id: Ref<Class<Obj>>, extendz: Ref<Class<Obj>>): any {
  return classTx(_id, { label: _id as unknown as IntlString, extends: extendz, kind: ClassifierKind.CLASS })
}

function mixin (_id: Ref<Class<Obj>>, extendz: Ref<Class<Obj>>): any {
  return classTx(_id, { label: _id as unknown as IntlString, extends: extendz, kind: ClassifierKind.MIXIN })
}

function prepare (): Hierarchy {
  const hierarchy = new Hierarchy()
  const txes = [
    classTx(core.class.Obj, { label: 'Obj' as IntlString, kind: ClassifierKind.CLASS }),
    cls(core.class.Doc, core.class.Obj),
    classTx(core.class.Class, {
      label: 'Class' as IntlString,
      extends: core.class.Doc,
      kind: ClassifierKind.CLASS,
      domain: DOMAIN_MODEL
    }),
    cls(test.class.Task, core.class.Doc),
    cls(test.class.Other, core.class.Doc),
    mixin(test.mixin.OnDoc, core.class.Doc),
    mixin(test.mixin.OnTask, test.class.Task),
    mixin(test.mixin.OnOther, test.class.Other),
    // Mixin whose parent is itself a mixin - the "lazy task-type data mixin" case.
    mixin(test.mixin.ChildOfOnTask, test.mixin.OnTask),
    mixin(test.mixin.Ignored, core.class.Doc),
    // Base class is Class, so it never shows up as an applicable mixin of a Doc.
    mixin(setting.mixin.ClassifierOrder, core.class.Class)
  ]
  for (const tx of txes) hierarchy.tx(tx)
  return hierarchy
}

function task (stamped: Array<Ref<Mixin<Doc>>> = [], _class: Ref<Class<Doc>> = test.class.Task): Doc {
  const doc: any = {
    _id: 'task-1' as Ref<Doc>,
    _class,
    space: core.space.Model,
    modifiedOn: 0,
    modifiedBy: core.account.System
  }
  for (const m of stamped) doc[m] = {}
  return doc
}

function setRank (hierarchy: Hierarchy, _class: Ref<Class<Obj>>, rank: Rank): void {
  hierarchy.tx(
    txFactory.createTxMixin(_class, core.class.Class, core.space.Model, setting.mixin.ClassifierOrder, { rank })
  )
}

const ids = (mixins: Array<Mixin<Doc>>): string[] => mixins.map((m) => m._id)

describe('filterDocMixins', () => {
  it('returns [] for undefined object', () => {
    expect(filterDocMixins(prepare(), undefined as unknown as Doc)).toEqual([])
  })

  it('returns only stamped mixins when showAllMixins is false', () => {
    const hierarchy = prepare()
    expect(ids(filterDocMixins(hierarchy, task()))).toEqual([])
    expect(ids(filterDocMixins(hierarchy, task([test.mixin.OnTask])))).toEqual([test.mixin.OnTask])
  })

  it('returns stamped mixin even when not applicable to the class', () => {
    const hierarchy = prepare()
    // OnOther has base class Other, Task does not derive from it - but it is stamped, so it shows.
    expect(ids(filterDocMixins(hierarchy, task([test.mixin.OnOther])))).toEqual([test.mixin.OnOther])
  })

  it('showAllMixins includes applicable mixins and excludes foreign ones', () => {
    const result = ids(filterDocMixins(prepare(), task(), true))
    expect(result).toEqual(expect.arrayContaining([test.mixin.OnDoc, test.mixin.OnTask, test.mixin.Ignored]))
    expect(result).not.toContain(test.mixin.OnOther)
  })

  it('showAllMixins includes a mixin whose parent mixin is applicable but not stamped', () => {
    // Regression guard: previously required hasMixin(object, ChildOfOnTask.extends).
    const result = ids(filterDocMixins(prepare(), task(), true))
    expect(result).toContain(test.mixin.ChildOfOnTask)
  })

  it('excludes a child mixin when its parent mixin is not applicable to the class', () => {
    const hierarchy = prepare()
    hierarchy.tx(mixin('test:mixin:ChildOfOnOther' as Ref<Class<Obj>>, test.mixin.OnOther))
    const result = ids(filterDocMixins(hierarchy, task(), true))
    expect(result).not.toContain('test:mixin:ChildOfOnOther')
  })

  it('excludes a child mixin of a foreign class even when its parent mixin is stamped', () => {
    // getBaseClass walks past the parent mixin to Other, so the class guard rejects it first -
    // stamping the parent does not bring the child in.
    const hierarchy = prepare()
    hierarchy.tx(mixin('test:mixin:ChildOfOnOther' as Ref<Class<Obj>>, test.mixin.OnOther))
    const result = ids(filterDocMixins(hierarchy, task([test.mixin.OnOther]), true))
    expect(result).not.toContain('test:mixin:ChildOfOnOther')
  })

  it('honours ignoreMixins for both stamped and applicable mixins', () => {
    const hierarchy = prepare()
    const ignore = new Set<Ref<Mixin<Doc>>>([test.mixin.Ignored, test.mixin.OnTask])
    const result = ids(filterDocMixins(hierarchy, task([test.mixin.OnTask]), true, ignore))
    expect(result).not.toContain(test.mixin.Ignored)
    expect(result).not.toContain(test.mixin.OnTask)
    expect(result).toContain(test.mixin.OnDoc)
  })

  it('uses objectClass override instead of object._class', () => {
    const hierarchy = prepare()
    const doc = task([], test.class.Other)
    expect(ids(filterDocMixins(hierarchy, doc, true))).toContain(test.mixin.OnOther)
    expect(ids(filterDocMixins(hierarchy, doc, true))).not.toContain(test.mixin.OnTask)

    const overridden = ids(filterDocMixins(hierarchy, doc, true, new Set(), test.class.Task))
    expect(overridden).toContain(test.mixin.OnTask)
    expect(overridden).not.toContain(test.mixin.OnOther)
  })

  it('orders mixins by ClassifierOrder rank', () => {
    const hierarchy = prepare()
    const natural = ids(filterDocMixins(hierarchy, task(), true))
    expect(natural.length).toBeGreaterThan(1)

    // Assign ranks that reverse the fallback order - proves ClassifierOrder wins over toRank(_id).
    const reversed = [...natural].reverse()
    reversed.forEach((_id, i) => {
      setRank(hierarchy, _id as Ref<Class<Obj>>, `0|a${String.fromCharCode(97 + i)}:`)
    })

    expect(ids(filterDocMixins(hierarchy, task(), true))).toEqual(reversed)
  })

  it('falls back to a stable id-derived rank when ClassifierOrder is absent', () => {
    const hierarchy = prepare()
    expect(ids(filterDocMixins(hierarchy, task(), true))).toEqual(ids(filterDocMixins(prepare(), task(), true)))
  })
})
