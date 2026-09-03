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
  Hierarchy,
  MeasureMetricsContext,
  ModelDb,
  type Class,
  type Classifier,
  type Doc,
  type Mixin,
  type Ref,
  type Tx
} from '@hcengineering/core'
import builder from '..'

const ctx = new MeasureMetricsContext('test', {})

let model: Tx[]
let hierarchy: Hierarchy
let modelDb: ModelDb

beforeAll(() => {
  model = builder().getTxes()
  hierarchy = new Hierarchy()
  for (const tx of model) {
    hierarchy.tx(tx)
  }
  modelDb = new ModelDb(hierarchy)
  modelDb.addTxes(ctx, model, true)
})

function classifiers (): Ref<Classifier>[] {
  return modelDb.findAllSync(core.class.Class, {}).map((it) => it._id as Ref<Classifier>)
}

describe('built model resolves', () => {
  it('has a non-trivial model', () => {
    expect(model.length).toBeGreaterThan(1000)
    expect(classifiers().length).toBeGreaterThan(100)
  })

  it('resolves every class up to core:class:Obj', () => {
    const broken: string[] = []
    for (const _id of classifiers()) {
      const cl = hierarchy.getClass(_id as Ref<Class<Doc>>)
      if (cl.kind === ClassifierKind.INTERFACE) continue
      if (!hierarchy.getAncestors(_id).includes(core.class.Obj)) {
        broken.push(_id)
      }
    }
    expect(broken).toEqual([])
  })

  // A domain declared on any ancestor must stay reachable from the class itself.
  it('inherits a domain from ancestors', () => {
    const notInherited: string[] = []
    for (const _id of classifiers()) {
      const cl = hierarchy.getClass(_id as Ref<Class<Doc>>)
      if (cl.kind !== ClassifierKind.CLASS) continue
      const fromAncestor = hierarchy
        .getAncestors(_id)
        .some((a) => hierarchy.findClass(a as Ref<Class<Doc>>)?.domain !== undefined)
      if (fromAncestor && hierarchy.findDomain(_id as Ref<Class<Doc>>) === undefined) {
        notInherited.push(_id)
      }
    }
    expect(notInherited).toEqual([])
  })

  it('lists every class as a descendant of core:class:Obj', () => {
    const descendants = new Set(hierarchy.getDescendants(core.class.Obj))
    const missing = classifiers().filter((it) => !descendants.has(it))
    expect(missing).toEqual([])
  })

  it('resolves parents of every class', () => {
    const unresolved: string[] = []
    for (const _id of classifiers()) {
      const cl = hierarchy.getClass(_id as Ref<Class<Doc>>)
      if (cl.extends !== undefined && hierarchy.findClass(cl.extends) === undefined) {
        unresolved.push(`${_id} extends ${cl.extends}`)
      }
      for (const int of cl.implements ?? []) {
        if (hierarchy.findClass(int as unknown as Ref<Class<Doc>>) === undefined) {
          unresolved.push(`${_id} implements ${int}`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })

  it('attaches every attribute to a known class', () => {
    const orphans: string[] = []
    for (const attr of modelDb.findAllSync(core.class.Attribute, {})) {
      if (hierarchy.findClass(attr.attributeOf as Ref<Class<Doc>>) === undefined) {
        orphans.push(`${attr._id} of ${attr.attributeOf}`)
      }
    }
    expect(orphans).toEqual([])
  })

  it('shares one instance between ModelDb and Hierarchy', () => {
    for (const _id of classifiers().slice(0, 50)) {
      expect(modelDb.findObject(_id)).toBe(hierarchy.getClass(_id as Ref<Class<Doc>>))
    }
  })

  it('indexes every model document under its base classes', () => {
    const docs = modelDb.findAllSync(core.class.Doc, {})
    expect(docs.length).toBeGreaterThan(1000)
    const ids = new Set(docs.map((d) => d._id))
    for (const cls of [core.class.Class, core.class.Attribute]) {
      for (const doc of modelDb.findAllSync(cls, {})) {
        expect(ids.has(doc._id)).toBe(true)
      }
    }
  })
})

// The overlay is only useful if it answers exactly what a standalone model answers.
describe('shared overlay answers like a standalone model', () => {
  let alone: { h: Hierarchy, db: ModelDb }
  let overlay: { h: Hierarchy, db: ModelDb }
  let classes: Ref<Class<Doc>>[]

  beforeAll(() => {
    const aloneH = new Hierarchy()
    const aloneDb = new ModelDb(aloneH)
    aloneDb.addTxes(ctx, model, true)
    alone = { h: aloneH, db: aloneDb }

    const sharedH = new Hierarchy()
    const sharedDb = new ModelDb(sharedH)
    sharedDb.addTxes(ctx, model, true)
    sharedDb.freeze()
    const oh = new Hierarchy(sharedH)
    overlay = { h: oh, db: new ModelDb(oh, sharedDb) }

    classes = aloneDb.findAllSync(core.class.Class, {}).map((it) => it._id) as Ref<Class<Doc>>[]
  })

  /** Compares per class and reports the offenders, a bare boolean says nothing about which class broke. */
  function sameForEveryClass (
    name: string,
    fn: (m: { h: Hierarchy, db: ModelDb }, c: Ref<Class<Doc>>) => unknown
  ): void {
    const diff: string[] = []
    for (const c of classes) {
      const a = JSON.stringify(fn(alone, c) ?? null)
      const b = JSON.stringify(fn(overlay, c) ?? null)
      if (a !== b) diff.push(`${name} ${c}: ${a} != ${b}`)
    }
    expect(diff).toEqual([])
  }

  it('getAncestors', () => {
    sameForEveryClass('getAncestors', (m, c) => m.h.getAncestors(c))
  })

  it('getDescendants', () => {
    sameForEveryClass('getDescendants', (m, c) => [...m.h.getDescendants(c)].sort())
  })

  it('isDerived to Doc and Obj', () => {
    sameForEveryClass('isDerived', (m, c) => [m.h.isDerived(c, core.class.Doc), m.h.isDerived(c, core.class.Obj)])
  })

  it('findDomain', () => {
    sameForEveryClass('findDomain', (m, c) => m.h.findDomain(c))
  })

  it('getClass / isMixin / getBaseClass', () => {
    sameForEveryClass('getClass', (m, c) => m.h.getClass(c))
    sameForEveryClass('isMixin', (m, c) => m.h.isMixin(c))
    sameForEveryClass('getBaseClass', (m, c) => m.h.getBaseClass(c))
  })

  it('getAllAttributes / getOwnAttributes', () => {
    sameForEveryClass('getAllAttributes', (m, c) => [...m.h.getAllAttributes(c).keys()].sort())
    sameForEveryClass('getOwnAttributes', (m, c) => [...m.h.getOwnAttributes(c).keys()].sort())
  })

  it('findAttribute for every own attribute name', () => {
    const diff: string[] = []
    for (const c of classes) {
      for (const name of alone.h.getAllAttributes(c).keys()) {
        const a = alone.h.findAttribute(c, name)?._id
        const b = overlay.h.findAttribute(c, name)?._id
        if (a !== b) diff.push(`${c}.${name}: ${a} != ${b}`)
      }
    }
    expect(diff).toEqual([])
  })

  it('domains', () => {
    expect([...overlay.h.domains()].sort()).toEqual([...alone.h.domains()].sort())
  })

  it('getMixinClasses', () => {
    const mixins = classes.filter((it) => alone.h.isMixin(it)).slice(0, 25) as unknown as Ref<Mixin<Doc>>[]
    for (const mixin of mixins) {
      expect([...overlay.h.getMixinClasses(mixin)].sort()).toEqual([...alone.h.getMixinClasses(mixin)].sort())
    }
  })

  it('findAllSync by class, by _id and by $in', () => {
    const ids = alone.db.findAllSync(core.class.Doc, {}).map((it) => it._id)
    expect(overlay.db.findAllSync(core.class.Doc, {}).length).toBe(ids.length)
    for (const cls of [core.class.Class, core.class.Attribute, core.class.Mixin]) {
      expect(overlay.db.findAllSync(cls, {}).length).toBe(alone.db.findAllSync(cls, {}).length)
    }
    const sample = ids.slice(0, 200)
    for (const _id of sample) {
      expect(overlay.db.findObject(_id)).toEqual(alone.db.findObject(_id))
    }
    expect(overlay.db.findAllSync(core.class.Doc, { _id: { $in: sample } }).length).toBe(sample.length)
  })

  it('keeps every shared document frozen', () => {
    expect(overlay.db.findAllSync(core.class.Doc, {}).every((it) => Object.isFrozen(it))).toBe(true)
  })

  it('reads a mixin off a frozen shared document', () => {
    const diff: string[] = []
    for (const doc of overlay.db.findAllSync(core.class.Doc, {})) {
      for (const key of Object.keys(doc)) {
        const mixin = key as Ref<Mixin<Doc>>
        if (alone.h.findClass(key as Ref<Class<Doc>>)?.kind !== ClassifierKind.MIXIN) continue
        const a = JSON.stringify(Hierarchy.toDoc(alone.h.as(alone.db.getObject(doc._id), mixin)))
        const b = JSON.stringify(Hierarchy.toDoc(overlay.h.as(doc, mixin)))
        if (a !== b) diff.push(`${doc._id} as ${mixin}`)
      }
    }
    expect(diff).toEqual([])
  })
})
