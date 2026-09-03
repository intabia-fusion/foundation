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

/* eslint-disable no-console */

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
import { bench, describeBench, type BenchOptions } from '@hcengineering/measurements'
import builder from '..'

// Cost of the model per workspace: a transactor builds these structures for every one it serves.
// Run with: BENCH=1 npx jest model.bench            (add --expose-gc for the memory figure)
const ctx = new MeasureMetricsContext('bench', {})

// full-model build ops are heavy, keep iteration count small and fixed
const buildOpts = { warmup: 5, minIters: 20, maxIters: 20 }

describeBench('model build performance', () => {
  let model: Tx[]
  let all: Ref<Classifier>[]
  let h: Hierarchy
  let db: ModelDb

  beforeAll(() => {
    model = builder().getTxes()
    h = new Hierarchy()
    for (const tx of model) h.tx(tx)
    db = new ModelDb(h)
    db.addTxes(ctx, model, true)
    all = db.findAllSync(core.class.Class, {}).map((it) => it._id as Ref<Classifier>)
    console.log(`model: ${model.length} txes, ${all.length} classes`)
  })

  it('builds hierarchy', async () => {
    await bench(
      'Hierarchy.tx over full model',
      () => {
        const h = new Hierarchy()
        for (const tx of model) h.tx(tx)
      },
      buildOpts
    )
  })

  it('builds model db', async () => {
    await bench(
      'ModelDb.addTxes over full model',
      () => {
        const db = new ModelDb(h)
        db.addTxes(ctx, model, true)
      },
      buildOpts
    )
  })

  // What ModelMiddleware.init does: ModelDb feeds the hierarchy, no separate pass.
  it('builds a whole workspace model', async () => {
    await bench(
      'full per-workspace build',
      () => {
        const h = new Hierarchy()
        const db = new ModelDb(h)
        db.addTxes(ctx, model, true)
      },
      buildOpts
    )
  })

  it('derives all ancestor chains', async () => {
    await bench(
      'derive every ancestor chain',
      () => {
        const h = new Hierarchy()
        for (const tx of model) h.tx(tx)
        for (const c of all) h.getAncestors(c)
      },
      buildOpts
    )
  })

  it('isDerived (warm)', async () => {
    let i = 0
    await bench('isDerived (warm)', () => {
      h.isDerived(all[i++ % all.length] as Ref<Class<Doc>>, core.class.Doc)
    })
  })

  it('getAncestors (warm)', async () => {
    let i = 0
    await bench('getAncestors (warm)', () => {
      h.getAncestors(all[i++ % all.length])
    })
  })

  it('getDescendants(Doc)', async () => {
    await bench('getDescendants(Doc)', () => {
      h.getDescendants(core.class.Doc)
    })
  })

  it('findDomain', async () => {
    let i = 0
    await bench('findDomain', () => {
      h.findDomain(all[i++ % all.length] as Ref<Class<Doc>>)
    })
  })

  it('findAllSync(Attribute)', async () => {
    await bench('findAllSync(Attribute)', () => {
      db.findAllSync(core.class.Attribute, {})
    })
  })

  it('measures per-workspace memory', () => {
    const gc = global.gc
    if (gc == null) {
      console.log('bench per-workspace memory: run node with --expose-gc for this figure')
      return
    }
    const heap = (): number => {
      gc()
      gc()
      return process.memoryUsage().heapUsed
    }
    const N = 20
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(2)

    const standalone: unknown[] = []
    let start = heap()
    for (let i = 0; i < N; i++) {
      const wh = new Hierarchy()
      const wdb = new ModelDb(wh)
      wdb.addTxes(ctx, model, true)
      standalone.push([wh, wdb])
    }
    const perStandalone = (heap() - start) / N

    start = heap()
    const sharedHierarchy = new Hierarchy()
    const sharedDb = new ModelDb(sharedHierarchy)
    sharedDb.addTxes(ctx, model, true)
    sharedDb.freeze()
    const sharedSize = heap() - start

    const overlays: unknown[] = []
    start = heap()
    for (let i = 0; i < N; i++) {
      const wh = new Hierarchy(sharedHierarchy)
      overlays.push([wh, new ModelDb(wh, sharedDb)])
    }
    const perOverlay = (heap() - start) / N

    console.log(
      `bench heap: standalone ${mb(perStandalone)} Mb/ws, shared model ${mb(sharedSize)} Mb once + ${mb(perOverlay)} Mb/ws`
    )
    expect(standalone.length + overlays.length).toBe(N * 2)
  })
})

// Every read the transactor makes against the model, standalone against an overlay over the
// shared system model. The gap between the two tags is the price of sharing.
describeBench('model read performance', () => {
  interface Config {
    tag: string
    h: Hierarchy
    db: ModelDb
  }
  let configs: Config[]
  let classes: Ref<Class<Doc>>[]
  let mixins: Ref<Mixin<Doc>>[]
  let docIds: Ref<Doc>[]
  let mixinDocs: Array<[Doc, Ref<Mixin<Doc>>]>

  const heavy = { warmup: 2, minIters: 10, maxIters: 50 }

  beforeAll(() => {
    const model = builder().getTxes()

    const sh = new Hierarchy()
    const sdb = new ModelDb(sh)
    sdb.addTxes(ctx, model, true)
    sdb.freeze()

    const oh = new Hierarchy(sh)
    const alone = new Hierarchy()
    const aloneDb = new ModelDb(alone)
    aloneDb.addTxes(ctx, model, true)

    configs = [
      { tag: 'standalone', h: alone, db: aloneDb },
      { tag: 'overlay', h: oh, db: new ModelDb(oh, sdb) }
    ]

    classes = aloneDb.findAllSync(core.class.Class, {}).map((it) => it._id) as Ref<Class<Doc>>[]
    mixins = classes.filter((it) => alone.isMixin(it)) as unknown as Ref<Mixin<Doc>>[]
    const docs = aloneDb.findAllSync(core.class.Doc, {})
    docIds = docs.map((it) => it._id)
    mixinDocs = []
    for (const doc of docs) {
      for (const key of Object.keys(doc)) {
        if (alone.findClass(key as Ref<Class<Doc>>)?.kind === ClassifierKind.MIXIN) {
          mixinDocs.push([doc, key as Ref<Mixin<Doc>>])
        }
      }
    }
    console.log(
      `read bench set: ${classes.length} classes, ${mixins.length} mixins, ${docIds.length} docs, ${mixinDocs.length} mixin instances`
    )
  })

  async function both (name: string, fn: (c: Config, i: number) => void, opts?: BenchOptions): Promise<void> {
    for (const c of configs) {
      let i = 0
      await bench(
        `${name} [${c.tag}]`,
        () => {
          fn(c, i++)
        },
        opts
      )
    }
  }

  it('isDerived', async () => {
    await both('isDerived', (c, i) => {
      c.h.isDerived(classes[i % classes.length], core.class.Doc)
    })
  })

  it('getAncestors', async () => {
    await both('getAncestors', (c, i) => {
      c.h.getAncestors(classes[i % classes.length])
    })
  })

  it('getDescendants', async () => {
    await both('getDescendants(Doc)', (c) => {
      c.h.getDescendants(core.class.Doc)
    })
    await both(
      'getDescendants(every class)',
      (c) => {
        for (const cl of classes) c.h.getDescendants(cl)
      },
      heavy
    )
  })

  it('getClass / findClass', async () => {
    await both('getClass', (c, i) => {
      c.h.getClass(classes[i % classes.length])
    })
    await both('findClass', (c, i) => {
      c.h.findClass(classes[i % classes.length])
    })
  })

  it('isMixin / getBaseClass', async () => {
    await both('isMixin', (c, i) => {
      c.h.isMixin(classes[i % classes.length])
    })
    await both('getBaseClass', (c, i) => {
      c.h.getBaseClass(classes[i % classes.length])
    })
  })

  it('findDomain', async () => {
    await both('findDomain', (c, i) => {
      c.h.findDomain(classes[i % classes.length])
    })
  })

  it('attributes', async () => {
    await both('getAllAttributes', (c, i) => {
      c.h.getAllAttributes(classes[i % classes.length])
    })
    await both('getOwnAttributes', (c, i) => {
      c.h.getOwnAttributes(classes[i % classes.length])
    })
    await both('findAttribute(_id)', (c, i) => {
      c.h.findAttribute(classes[i % classes.length], '_id')
    })
  })

  it('mixin access', async () => {
    await both('as (mixin over model doc)', (c, i) => {
      const [doc, mixin] = mixinDocs[i % mixinDocs.length]
      c.h.as(doc, mixin)
    })
    await both('as + read (mixin over model doc)', (c, i) => {
      const [doc, mixin] = mixinDocs[i % mixinDocs.length]
      void (c.h.as(doc, mixin) as any).label
    })
    await both('classHierarchyMixin', (c, i) => {
      c.h.classHierarchyMixin(classes[i % classes.length], mixins[i % mixins.length])
    })
    await both(
      'getMixinClasses',
      (c, i) => {
        c.h.getMixinClasses(mixins[i % mixins.length])
      },
      heavy
    )
  })

  it('domains', async () => {
    await both(
      'domains()',
      (c) => {
        c.h.domains()
      },
      heavy
    )
  })

  it('model lookups', async () => {
    await both('findObject', (c, i) => {
      c.db.findObject(docIds[i % docIds.length])
    })
    await both('findAllSync by _id', (c, i) => {
      c.db.findAllSync(core.class.Doc, { _id: docIds[i % docIds.length] })
    })
    await both('findAllSync by $in(50)', (c, i) => {
      c.db.findAllSync(core.class.Doc, { _id: { $in: docIds.slice(i % 100, (i % 100) + 50) } })
    })
    await both('findAllSync(Attribute)', (c) => {
      c.db.findAllSync(core.class.Attribute, {})
    })
    await both(
      'findAllSync(Doc)',
      (c) => {
        c.db.findAllSync(core.class.Doc, {})
      },
      heavy
    )
  })
})
