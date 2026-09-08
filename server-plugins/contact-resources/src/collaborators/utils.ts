// Copyright © 2025 Hardcore Engineering Inc.
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
  AccountUuid,
  AnyAttribute,
  ArrOf,
  Class,
  ClassCollaborators,
  Collaborator,
  Doc,
  DocumentUpdate,
  getClassCollaborators,
  MixinUpdate,
  notEmpty,
  Ref,
  RefTo,
  Space,
  Tx,
  TxCUD,
  TxUpdateDoc,
  isMixinTx
} from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'
import { MeasureContext } from '@hcengineering/measurements'
import contact from '@hcengineering/contact'
import { getAccountBySocialId, getAddCollaboratorsTxes, getEmployeesBySocialIds } from '@hcengineering/server-contact'

async function getValueCollaborators (
  ctx: MeasureContext,
  control: TriggerControl,
  value: any,
  attr: AnyAttribute
): Promise<AccountUuid[]> {
  const hierarchy = control.hierarchy
  if (attr.type._class === core.class.RefTo) {
    const to = (attr.type as RefTo<Doc>).to

    if (hierarchy.isDerived(to, contact.class.Person)) {
      const employee = await control.findAll(
        ctx,
        contact.mixin.Employee,
        {
          _id: value,
          active: true
        },
        { limit: 1 }
      )

      return employee[0]?.personUuid != null ? [employee[0].personUuid] : []
    }
  } else if (attr.type._class === core.class.TypeAccountUuid) {
    return [value]
  } else if (attr.type._class === core.class.TypePersonId) {
    const acc = await getAccountBySocialId(control, value)
    return acc == null ? [] : [acc]
  } else if (attr.type._class === core.class.ArrOf) {
    const arrOf = (attr.type as ArrOf<RefTo<Doc>>).of

    if (arrOf._class === core.class.RefTo) {
      const to = (arrOf as RefTo<Doc>).to
      if (hierarchy.isDerived(to, contact.class.Person)) {
        if (!Array.isArray(value)) {
          ctx.error('Expected array but got non-array value when getting value collaborators', { attr, value })
          return []
        }
        if (value.length === 0) return []
        if (value.every((it) => it === null)) {
          ctx.error('Null-values array of person refs when getting value collaborators', { attr, value })
        }

        const employees = await control.findAll(ctx, contact.mixin.Employee, {
          _id: { $in: value },
          active: true
        })

        return employees.map((e) => e.personUuid).filter(notEmpty)
      }
    } else if (arrOf._class === core.class.TypeAccountUuid) {
      return Array.isArray(value) ? value : [value]
    } else if (arrOf._class === core.class.TypePersonId) {
      const socialIds = Array.isArray(value) ? value : [value]
      const personsBySocialIds = await getEmployeesBySocialIds(control, socialIds)

      return Object.values(personsBySocialIds)
        .map((p) => p?.personUuid)
        .filter(notEmpty)
    }
  }
  return []
}

async function getKeyCollaborators (
  ctx: MeasureContext,
  control: TriggerControl,
  docClass: Ref<Class<Doc>>,
  value: any,
  field: string
): Promise<AccountUuid[] | undefined> {
  if (value !== undefined && value !== null) {
    const attr = control.hierarchy.findAttribute(docClass, field)
    if (attr !== undefined) {
      return await getValueCollaborators(ctx, control, value, attr)
    }
  }
}

export async function getCollaboratorsFromDocFields (
  ctx: MeasureContext,
  control: TriggerControl,
  doc: Doc,
  mixin: ClassCollaborators<Doc>
): Promise<AccountUuid[]> {
  return await ctx.with('get-collaborators-from-doc-fields', {}, async (ctx) => {
    const collaborators = new Set<AccountUuid>()
    if (mixin.allFields !== true) {
      for (const field of mixin.fields) {
        const value = (doc as any)[field]
        const newCollaborators = await getKeyCollaborators(ctx, control, doc._class, value, field)
        if (newCollaborators !== undefined) {
          for (const newCollaborator of newCollaborators) {
            collaborators.add(newCollaborator)
          }
        }
      }
    } else {
      const attrs = control.hierarchy.getAllAttributes(doc._class)
      // attr type will be checked into getKeyCollaborators
      for (const [field] of attrs) {
        const value = (doc as any)[field]
        const newCollaborators = await getKeyCollaborators(ctx, control, doc._class, value, field)
        if (newCollaborators !== undefined) {
          for (const newCollaborator of newCollaborators) {
            collaborators.add(newCollaborator)
          }
        }
      }
    }
    return Array.from(collaborators.values())
  })
}

export async function getCollaboratorsCached (
  ctx: MeasureContext,
  control: TriggerControl,
  _id: Ref<Doc>,
  cache: Map<Ref<Doc>, Collaborator[]>
): Promise<Collaborator[]> {
  const collaborators =
    cache.get(_id) ??
    (await control.findAll(ctx, core.class.Collaborator, {
      attachedTo: _id
    }))
  cache.set(_id, collaborators)

  return collaborators
}

export async function getDocCached (
  ctx: MeasureContext,
  control: TriggerControl,
  _class: Ref<Class<Doc>>,
  _id: Ref<Doc>,
  docCache: Map<Ref<Doc>, Doc>
): Promise<Doc | undefined> {
  const cached = docCache.get(_id)
  if (cached !== undefined) return cached

  const doc = (await control.findAll(ctx, _class, { _id }, { limit: 1 }))[0]
  if (doc === undefined) return undefined

  docCache.set(doc._id, doc)

  return doc
}

export async function getMembersRemovedFromSpace (
  ctx: MeasureContext,
  control: TriggerControl,
  ops: DocumentUpdate<Space> | MixinUpdate<Space, Space>,
  mixin: ClassCollaborators<Doc>,
  _class: Ref<Class<Space>>
): Promise<AccountUuid[]> {
  const removed: AccountUuid[] = []
  if (ops.$pull !== undefined && 'members' in ops.$pull) {
    const key = 'members'
    if (mixin.fields.includes(key as any) || mixin.allFields === true) {
      let value = (ops.$pull as any)[key]
      if (typeof value !== 'string') {
        value = value.$in
      }
      const collabs = await getKeyCollaborators(ctx, control, _class, value, key)
      if (collabs !== undefined) {
        removed.push(...collabs)
      }
    }
  }

  return Array.from(new Set(removed))
}

export async function getCollaborators (
  ctx: MeasureContext,
  control: TriggerControl,
  doc: Doc,
  tx: TxCUD<Doc>,
  res: Tx[]
): Promise<AccountUuid[]> {
  const mixin = getClassCollaborators(control.modelDb, control.hierarchy, doc._class)

  if (mixin === undefined) {
    return []
  }

  const collaborators = await control.findAll(ctx, core.class.Collaborator, {
    attachedTo: doc._id
  })

  if (collaborators.length > 0) {
    return collaborators.map((p) => p.collaborator)
  } else {
    const collaborators = await getCollaboratorsFromDocFields(ctx, control, doc, mixin)

    res.push(...getAddCollaboratorsTxes(tx.objectId, tx.objectClass, tx.objectSpace, control, collaborators))
    return collaborators
  }
}

async function getNewCollaborators (
  ctx: MeasureContext,
  control: TriggerControl,
  ops: DocumentUpdate<Doc> | MixinUpdate<Doc, Doc>,
  mixin: ClassCollaborators<Doc>,
  docClass: Ref<Class<Doc>>
): Promise<AccountUuid[]> {
  const newCollaborators = new Set<AccountUuid>()
  if (ops.$push !== undefined) {
    for (const key in ops.$push) {
      if (mixin.fields.includes(key as any) || mixin.allFields === true) {
        let value = (ops.$push as any)[key]
        if (typeof value !== 'string') {
          value = value.$each
        }
        const newCollabs = await getKeyCollaborators(ctx, control, docClass, value, key)
        if (newCollabs !== undefined) {
          for (const newCollab of newCollabs) {
            newCollaborators.add(newCollab)
          }
        }
      }
    }
  }
  for (const key in ops) {
    if (key.startsWith('$')) continue
    if (mixin.fields.includes(key as any) || mixin.allFields === true) {
      const value = (ops as any)[key]
      const newCollabs = await getKeyCollaborators(ctx, control, docClass, value, key)
      if (newCollabs !== undefined) {
        for (const newCollab of newCollabs) {
          newCollaborators.add(newCollab)
        }
      }
    }
  }

  return Array.from(newCollaborators)
}

export async function getCollaboratorsByTx (
  ctx: MeasureContext,
  control: TriggerControl,
  tx: TxCUD<Doc>,
  doc: Doc,
  cache: Map<Ref<Doc>, Collaborator[]>
): Promise<{
  added: AccountUuid[]
  removed: AccountUuid[]
}> {
  return await ctx.with('get-doc-collaborators-by-tx', {}, async (ctx) => {
    const { hierarchy } = control

    const mixin = getClassCollaborators(control.modelDb, hierarchy, doc._class)
    if (mixin === undefined) {
      return {
        added: [],
        removed: []
      }
    }

    if (tx._class === core.class.TxCreateDoc) {
      const collabs = await getCollaboratorsFromDocFields(ctx, control, doc, mixin)
      return {
        added: collabs,
        removed: []
      }
    }

    if (tx._class === core.class.TxRemoveDoc) {
      return {
        added: [],
        removed: []
      }
    }

    if ([core.class.TxUpdateDoc, core.class.TxMixin].includes(tx._class)) {
      const collaborators = (await getCollaboratorsCached(ctx, control, doc._id, cache)).map((c) => c.collaborator)

      const ops = isMixinTx(tx) ? tx.attributes : (tx as TxUpdateDoc<Doc>).operations
      const added = (await getNewCollaborators(ctx, control, ops, mixin, doc._class)).filter(
        (it) => !collaborators.includes(it)
      )
      const isSpace = control.hierarchy.isDerived(doc._class, core.class.Space)
      const removed = isSpace ? await getMembersRemovedFromSpace(ctx, control, ops, mixin, (doc as Space)._class) : []

      return {
        added,
        removed
      }
    }

    return {
      added: [],
      removed: []
    }
  })
}

export async function getDocSpace (control: TriggerControl, doc: Doc, cache: Map<Ref<Doc>, Doc>): Promise<Space> {
  return control.hierarchy.isDerived(doc._class, core.class.Space)
    ? (doc as Space)
    : ((cache.get(doc.space) as Space) ??
        (await control.findAll<Space>(control.ctx, core.class.Space, { _id: doc.space }, { limit: 1 }))[0])
}
