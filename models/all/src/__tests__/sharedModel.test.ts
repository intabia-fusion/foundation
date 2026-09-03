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
  TxFactory,
  type AnyAttribute,
  type Class,
  type Classifier,
  type Doc,
  type Mixin,
  type Ref,
  type Tx
} from '@hcengineering/core'
import builder from '..'

const ctx = new MeasureMetricsContext('test', {})
const factory = new TxFactory(core.account.System)

// task lives outside this package's dependencies, so its model classes are referenced by id.
const TASK_TYPE = 'task:class:TaskType' as Ref<Class<Doc>>
const PROJECT_TYPE = 'task:class:ProjectType' as Ref<Class<Doc>>
interface TaskTypeDoc extends Doc {
  name: string
  statuses: string[]
}
interface ProjectTypeDoc extends Doc {
  name: string
  tasks: string[]
}

let model: Tx[]
let base: { h: Hierarchy, db: ModelDb }
let baseline: string
let hierarchyBaseline: string

function snapshot (db: ModelDb): string {
  const docs = db.findAllSync(core.class.Doc, {}).slice()
  docs.sort((a, b) => a._id.localeCompare(b._id))
  return JSON.stringify(docs)
}

/** Every structure the hierarchy derives, so a leak into a cache is caught as well. */
function hierarchySnapshot (m: { h: Hierarchy, db: ModelDb }): string {
  const ids = m.db
    .findAllSync(core.class.Class, {})
    .map((it) => it._id as Ref<Classifier>)
    .slice()
    .sort()
  return JSON.stringify({
    domains: m.h.domains().slice().sort(),
    classifiers: ids.map((_id) => ({
      _id,
      ancestors: m.h.getAncestors(_id).slice().sort(),
      descendants: m.h
        .getDescendants(_id as Ref<Class<Doc>>)
        .slice()
        .sort(),
      own: Array.from(m.h.getOwnAttributes(_id).keys()).sort(),
      all: Array.from(m.h.getAllAttributes(_id).keys()).sort(),
      domain: m.h.findDomain(_id as Ref<Class<Doc>>) ?? null
    }))
  })
}

function workspace (): { h: Hierarchy, db: ModelDb } {
  const h = new Hierarchy(base.h)
  return { h, db: new ModelDb(h, base.db) }
}

beforeAll(() => {
  model = builder().getTxes()
  const h = new Hierarchy()
  const db = new ModelDb(h)
  db.addTxes(ctx, model, true)
  db.freeze()
  base = { h, db }
  baseline = snapshot(db)
  hierarchyBaseline = hierarchySnapshot(base)
})

afterEach(() => {
  // The whole point of a shared model: no workspace operation may reach it.
  expect(snapshot(base.db)).toBe(baseline)
  expect(hierarchySnapshot(base)).toBe(hierarchyBaseline)
  // A fresh workspace must see exactly the shared model, with none of the previous test's edits.
  expect(hierarchySnapshot(workspace())).toBe(hierarchyBaseline)
  expect(base.db.findAllSync(core.class.Doc, {}).every((it) => Object.isFrozen(it))).toBe(true)
})

// A class the system model already carries the mixin on - the case that used to leak.
function mixedClass (): { _class: Ref<Class<Doc>>, mixin: Ref<Mixin<Doc>> } {
  for (const cl of base.db.findAllSync(core.class.Class, {})) {
    for (const [key, value] of Object.entries(cl)) {
      if (typeof value === 'object' && value !== null && base.h.findClass(key as Ref<Class<Doc>>) !== undefined) {
        return { _class: cl._id, mixin: key as Ref<Mixin<Doc>> }
      }
    }
  }
  throw new Error('no class with a mixin in the model')
}

function anyAttribute (): AnyAttribute {
  return base.db.findAllSync(core.class.Attribute, { hidden: { $ne: true } } as any)[0]
}

describe('workspace over the real system model', () => {
  it('reads the whole model through the parent', () => {
    const ws = workspace()

    expect(ws.db.findAllSync(core.class.Class, {}).length).toBe(base.db.findAllSync(core.class.Class, {}).length)
    expect(ws.h.getDescendants(core.class.Doc).length).toBe(base.h.getDescendants(core.class.Doc).length)
    expect(ws.h.getAllAttributes(core.class.Doc).size).toBe(base.h.getAllAttributes(core.class.Doc).size)
  })

  it('hides a system attribute', () => {
    const attr = anyAttribute()
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [factory.createTxUpdateDoc(attr._class, core.space.Model, attr._id, { hidden: true } as any)],
      true
    )

    expect(ws.h.findAttribute(attr.attributeOf, attr.name)?.hidden).toBe(true)
    expect(base.h.findAttribute(attr.attributeOf, attr.name)?.hidden).toBeUndefined()
    expect(workspace().h.findAttribute(attr.attributeOf, attr.name)?.hidden).toBeUndefined()
  })

  it('removes a system attribute', () => {
    const attr = anyAttribute()
    const ws = workspace()

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(attr._class, core.space.Model, attr._id)], true)

    expect(ws.h.findAttribute(attr.attributeOf, attr.name)).toBeUndefined()
    expect(ws.h.getAllAttributes(attr.attributeOf).has(attr.name)).toBe(false)
    expect(ws.db.findObject(attr._id)).toBeUndefined()
    expect(base.h.findAttribute(attr.attributeOf, attr.name)).toBeDefined()
  })

  it('adds a custom attribute to a system class', () => {
    const ws = workspace()
    const _id = 'test:attribute:Custom' as Ref<AnyAttribute>

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Attribute,
          core.space.Model,
          {
            attributeOf: core.class.Space,
            name: 'customField',
            label: core.string.Name,
            isCustom: true,
            type: { _class: core.class.TypeString, label: core.string.Name }
          } as any,
          _id
        )
      ],
      true
    )

    expect(ws.h.findAttribute(core.class.Space, 'customField')).toBeDefined()
    expect(base.h.findAttribute(core.class.Space, 'customField')).toBeUndefined()
    expect(workspace().h.findAttribute(core.class.Space, 'customField')).toBeUndefined()
  })

  it('updates a mixin the system class already carries', () => {
    const { _class, mixin } = mixedClass()
    const before = JSON.stringify((base.h.getClass(_class) as any)[mixin])
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [factory.createTxMixin(_class, core.class.Class, core.space.Model, mixin, { testMarker: 42 } as any)],
      true
    )

    expect((ws.h.getClass(_class) as any)[mixin].testMarker).toBe(42)
    expect(JSON.stringify((base.h.getClass(_class) as any)[mixin])).toBe(before)
    expect((workspace().h.getClass(_class) as any)[mixin].testMarker).toBeUndefined()
  })

  it('creates a user mixin over a system class', () => {
    const ws = workspace()
    const _id = 'test:mixin:UserMixin' as Ref<Class<Doc>>

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Mixin,
          core.space.Model,
          { kind: ClassifierKind.MIXIN, extends: core.class.Space, label: core.string.Name } as any,
          _id
        )
      ],
      true
    )

    expect(ws.h.isDerived(_id, core.class.Space)).toBe(true)
    expect(ws.h.getDescendants(core.class.Space)).toContain(_id)
    expect(base.h.getDescendants(core.class.Space)).not.toContain(_id)
    expect(() => base.h.getClass(_id)).toThrow()
  })

  it('pushes into an array of a system class', () => {
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [
        factory.createTxUpdateDoc(core.class.Class, core.space.Model, core.class.Space, {
          $push: { implements: 'test:interface:Marker' }
        } as any)
      ],
      true
    )

    const implementsOf = (h: Hierarchy): string[] => (h.getClass(core.class.Space) as any).implements ?? []
    expect(implementsOf(ws.h).filter((it) => it === 'test:interface:Marker')).toHaveLength(1)
    expect(implementsOf(base.h)).not.toContain('test:interface:Marker')
  })

  it('renames a system attribute without leaving it under the old name', () => {
    const attr = anyAttribute()
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [factory.createTxUpdateDoc(attr._class, core.space.Model, attr._id, { name: 'renamedField' } as any)],
      true
    )

    expect(ws.h.findAttribute(attr.attributeOf, 'renamedField')?._id).toBe(attr._id)
    expect(ws.h.getAllAttributes(attr.attributeOf).get('renamedField')?._id).toBe(attr._id)
    expect(ws.h.getAllAttributes(attr.attributeOf).get(attr.name)?._id).not.toBe(attr._id)
    expect(base.h.findAttribute(attr.attributeOf, attr.name)?._id).toBe(attr._id)
  })

  it('removes and re-creates a system attribute', () => {
    const attr = anyAttribute()
    const ws = workspace()

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(attr._class, core.space.Model, attr._id)], true)
    expect(ws.h.findAttribute(attr.attributeOf, attr.name)).toBeUndefined()

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Attribute,
          core.space.Model,
          { attributeOf: attr.attributeOf, name: attr.name, label: attr.label, type: attr.type } as any,
          attr._id
        )
      ],
      true
    )

    expect(ws.h.findAttribute(attr.attributeOf, attr.name)?._id).toBe(attr._id)
    expect(ws.db.findObject(attr._id)).toBeDefined()
  })

  it('changes the type of a system attribute', () => {
    const attr = anyAttribute()
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [
        factory.createTxUpdateDoc(attr._class, core.space.Model, attr._id, {
          'type._class': core.class.TypeNumber
        } as any)
      ],
      true
    )

    expect(ws.h.findAttribute(attr.attributeOf, attr.name)?.type._class).toBe(core.class.TypeNumber)
    expect(base.h.findAttribute(attr.attributeOf, attr.name)?.type._class).not.toBe(core.class.TypeNumber)
  })

  it('creates its own class and removes it again', () => {
    const ws = workspace()
    const _id = 'test:class:Own' as Ref<Class<Doc>>

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Class,
          core.space.Model,
          { kind: ClassifierKind.CLASS, extends: core.class.Space, label: core.string.Name } as any,
          _id
        )
      ],
      true
    )
    expect(ws.h.getDescendants(core.class.Space)).toContain(_id)
    expect(ws.h.findDomain(_id)).toBe(base.h.findDomain(core.class.Space))

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(core.class.Class, core.space.Model, _id)], true)

    expect(ws.h.findClass(_id)).toBeUndefined()
    expect(ws.h.getDescendants(core.class.Space)).not.toContain(_id)
  })

  it('removes a system class and its subtree', () => {
    const ws = workspace()
    const victim = core.class.AttachedDoc
    const child = base.h.getDescendants(victim).find((it) => it !== victim)

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(core.class.Class, core.space.Model, victim)], true)

    expect(ws.h.findClass(victim)).toBeUndefined()
    expect(ws.h.getDescendants(core.class.Doc)).not.toContain(victim)
    if (child !== undefined) {
      expect(ws.h.isDerived(child, core.class.Doc)).toBe(false)
      expect(base.h.isDerived(child, core.class.Doc)).toBe(true)
    }
  })

  it('re-points a system class under its own class', () => {
    const ws = workspace()
    const own = 'test:class:NewParent' as Ref<Class<Doc>>

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Class,
          core.space.Model,
          { kind: ClassifierKind.CLASS, extends: core.class.Doc, label: core.string.Name } as any,
          own
        ),
        factory.createTxUpdateDoc(core.class.Class, core.space.Model, core.class.Space, { extends: own } as any)
      ],
      true
    )

    expect(ws.h.isDerived(core.class.Space, own)).toBe(true)
    expect(ws.h.getDescendants(own)).toContain(core.class.Space)
    expect(base.h.getClass(core.class.Space).extends).toBe(core.class.Doc)
  })

  it('creates, updates and removes its own model document', () => {
    const ws = workspace()
    const _id = 'test:status:Own' as Ref<Doc>

    ws.db.addTxes(
      ctx,
      [
        factory.createTxCreateDoc(
          core.class.Space,
          core.space.Model,
          { name: 'own', description: '', private: false, archived: false, members: [] } as any,
          _id
        )
      ],
      true
    )
    expect(ws.db.findObject(_id)).toBeDefined()

    ws.db.addTxes(
      ctx,
      [factory.createTxUpdateDoc(core.class.Space, core.space.Model, _id, { name: 'edited' } as any)],
      true
    )
    expect((ws.db.findObject(_id) as any).name).toBe('edited')

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(core.class.Space, core.space.Model, _id)], true)
    expect(ws.db.findObject(_id)).toBeUndefined()
    expect(base.db.findObject(_id)).toBeUndefined()
  })

  it('serves cloned documents through the async findAll', async () => {
    const ws = workspace()
    const [doc] = await ws.db.findAll(core.class.Class, { _id: core.class.Space })

    expect(doc._id).toBe(core.class.Space)
    expect(Object.isFrozen(doc)).toBe(false)
    // a caller is free to mutate what findAll returned
    ;(doc as any).label = 'mutated'
    expect(base.h.getClass(core.class.Space).label).not.toBe('mutated')
  })

  it('renames a status without touching the shared one', () => {
    const status = base.db.findAllSync(core.class.Status, {})[0]
    expect(status).toBeDefined()
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [factory.createTxUpdateDoc(status._class, core.space.Model, status._id, { name: 'ws-renamed' } as any)],
      true
    )

    expect((ws.db.findObject(status._id) as any).name).toBe('ws-renamed')
    expect((base.db.findObject(status._id) as any).name).toBe(status.name)
    expect((workspace().db.findObject(status._id) as any).name).toBe(status.name)
  })

  it('removes a status only for the workspace that removed it', () => {
    const status = base.db.findAllSync(core.class.Status, {})[0]
    const total = base.db.findAllSync(core.class.Status, {}).length
    const ws = workspace()

    ws.db.addTxes(ctx, [factory.createTxRemoveDoc(status._class, core.space.Model, status._id)], true)

    expect(ws.db.findObject(status._id)).toBeUndefined()
    expect(ws.db.findAllSync(core.class.Status, {})).toHaveLength(total - 1)
    expect(base.db.findAllSync(core.class.Status, {})).toHaveLength(total)
    expect(workspace().db.findAllSync(core.class.Status, {})).toHaveLength(total)
  })

  it('renames a task type and rewrites its statuses', () => {
    const taskType = base.db.findAllSync<TaskTypeDoc>(TASK_TYPE, {})[0]
    expect(taskType).toBeDefined()
    const ws = workspace()
    const extraStatus = 'test:status:Extra'

    ws.db.addTxes(
      ctx,
      [
        factory.createTxUpdateDoc(taskType._class, core.space.Model, taskType._id, { name: 'ws-task-type' } as any),
        factory.createTxUpdateDoc(taskType._class, core.space.Model, taskType._id, {
          $push: { statuses: extraStatus }
        } as any)
      ],
      true
    )

    const own = ws.db.findObject(taskType._id) as any
    expect(own.name).toBe('ws-task-type')
    expect(own.statuses).toContain(extraStatus)
    const shared = base.db.findObject(taskType._id) as any
    expect(shared.name).toBe(taskType.name)
    expect(shared.statuses).not.toContain(extraStatus)
    expect((workspace().db.findObject(taskType._id) as any).statuses).not.toContain(extraStatus)
  })

  it('pulls a status out of a task type for one workspace only', () => {
    const taskType = base.db.findAllSync<TaskTypeDoc>(TASK_TYPE, {}).find((it) => it.statuses.length > 0) as TaskTypeDoc
    expect(taskType).toBeDefined()
    const victim = taskType.statuses[0]
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [
        factory.createTxUpdateDoc(taskType._class, core.space.Model, taskType._id, {
          $pull: { statuses: victim }
        } as any)
      ],
      true
    )

    expect((ws.db.findObject(taskType._id) as any).statuses).not.toContain(victim)
    expect((base.db.findObject(taskType._id) as any).statuses).toContain(victim)
  })

  it('edits a project type without leaking into the shared model', () => {
    const projectType = base.db.findAllSync<ProjectTypeDoc>(PROJECT_TYPE, {})[0]
    expect(projectType).toBeDefined()
    const ws = workspace()

    ws.db.addTxes(
      ctx,
      [
        factory.createTxUpdateDoc(projectType._class, core.space.Model, projectType._id, {
          name: 'ws-project-type',
          $push: { tasks: 'test:taskType:Extra' }
        } as any)
      ],
      true
    )

    const own = ws.db.findObject(projectType._id) as any
    expect(own.name).toBe('ws-project-type')
    expect(own.tasks).toContain('test:taskType:Extra')
    expect((base.db.findObject(projectType._id) as any).name).toBe(projectType.name)
    expect((base.db.findObject(projectType._id) as any).tasks).not.toContain('test:taskType:Extra')
  })

  it('keeps status and task type edits of parallel workspaces apart', () => {
    const status = base.db.findAllSync(core.class.Status, {})[0]
    const taskType = base.db.findAllSync<TaskTypeDoc>(TASK_TYPE, {})[0]
    const spaces = [workspace(), workspace(), workspace()]

    spaces.forEach((ws, i) => {
      ws.db.addTxes(
        ctx,
        [
          factory.createTxUpdateDoc(status._class, core.space.Model, status._id, { name: `status-${i}` } as any),
          factory.createTxUpdateDoc(taskType._class, core.space.Model, taskType._id, {
            $push: { statuses: `test:status:S${i}` }
          } as any)
        ],
        true
      )
    })

    spaces.forEach((ws, i) => {
      expect((ws.db.findObject(status._id) as any).name).toBe(`status-${i}`)
      const statuses = (ws.db.findObject(taskType._id) as any).statuses
      expect(statuses).toContain(`test:status:S${i}`)
      expect(statuses.filter((it: string) => it.startsWith('test:status:S'))).toHaveLength(1)
    })
  })

  it('keeps workspaces isolated when many of them write at once', () => {
    const attr = anyAttribute()
    const { _class, mixin } = mixedClass()
    const spaces = [workspace(), workspace(), workspace()]

    spaces.forEach((ws, i) => {
      ws.db.addTxes(
        ctx,
        [
          factory.createTxUpdateDoc(attr._class, core.space.Model, attr._id, { label: `ws-${i}` } as any),
          factory.createTxMixin(_class, core.class.Class, core.space.Model, mixin, { testMarker: i } as any)
        ],
        true
      )
    })

    spaces.forEach((ws, i) => {
      expect(ws.h.findAttribute(attr.attributeOf, attr.name)?.label).toBe(`ws-${i}`)
      expect((ws.h.getClass(_class) as any)[mixin].testMarker).toBe(i)
    })
  })
})
