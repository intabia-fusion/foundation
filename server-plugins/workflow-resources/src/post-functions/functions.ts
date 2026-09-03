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
  AccountUuid,
  AnyAttribute,
  ArrOf,
  AttachedDoc,
  type Class,
  Collaborator,
  Collection,
  Data,
  Doc,
  DocumentUpdate,
  groupByArray,
  type Hierarchy,
  MixinUpdate,
  notEmpty,
  type PropertyType,
  type Ref,
  type Tx,
  type TxCreateDoc,
  type TxCUD,
  TxProcessor
} from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import { type Task } from '@hcengineering/task'
import {
  type WorkflowTransition,
  type UpdateFieldValueProps,
  type ClearFieldValueProps,
  type UpdateFieldValueConfig
} from '@hcengineering/workflow'
import tags, { TagReference } from '@hcengineering/tags'

import { getCurrentUser, resolveValue } from './evaluator'

export async function UpdateFieldValue (
  control: TriggerControl,
  task: Task,
  _transition: WorkflowTransition,
  props: UpdateFieldValueProps,
  currentTxes: Tx[] = []
): Promise<Tx[]> {
  if (props?.fields == null || !Array.isArray(props.fields) || props.fields.length === 0) return []

  const h = control.hierarchy
  const res: Tx[] = []
  const update: DocumentUpdate<Task> = {}
  const unset: Record<string, true> = {}

  const fieldsByMixin = groupByArray(props.fields, (it) => it.mixin)

  for (const [mixin, configs] of fieldsByMixin.entries()) {
    if (mixin != null && !h.hasMixin(task, mixin)) continue

    const targetClass = mixin ?? task._class
    const mixinUpdate: MixinUpdate<Task, Task> = {}

    for (const config of configs) {
      if (config.fieldKey === '') continue

      const attr = h.findAttribute(targetClass, config.fieldKey)

      if (attr != null && isCollectionOrArrAttribute(h, attr)) {
        res.push(
          ...(await updateCollectionOrArrField(control, attr, targetClass, task, config, [...currentTxes, ...res]))
        )
      } else {
        const v = await resolveValue(config.value, task, control)
        if (v === undefined) continue
        if (mixin == null) {
          if (v === null) {
            unset[config.fieldKey] = true
          } else {
            ;(update as any)[config.fieldKey] = v
          }
        } else {
          ;(mixinUpdate as any)[config.fieldKey] = v
        }
      }
    }

    if (mixin != null && Object.keys(mixinUpdate).length > 0) {
      res.push(control.txFactory.createTxMixin(task._id, task._class, task.space, mixin, mixinUpdate))
    }
  }

  if (Object.keys(unset).length > 0) {
    update.$unset = unset
  }

  if (Object.keys(update).length > 0) {
    res.push(control.txFactory.createTxUpdateDoc(task._class, task.space, task._id, update))
  }

  return res
}

export async function ClearFieldValue (
  control: TriggerControl,
  task: Task,
  _transition: WorkflowTransition,
  props: ClearFieldValueProps
): Promise<Tx[]> {
  const fields = props.fields ?? []
  if (fields == null || !Array.isArray(props.fields) || props.fields.length === 0) return []

  const h = control.hierarchy
  const res: Tx[] = []
  const unset: Record<string, true> = {}

  for (const f of fields) {
    if (f.fieldKey === '' || (f.mixin != null && !h.hasMixin(task, f.mixin))) continue

    const attr = h.findAttribute(f.mixin ?? task._class, f.fieldKey)

    if (attr != null && h.isDerived(attr.type._class, core.class.Collection)) {
      const type = attr.type as Collection<AttachedDoc>
      const attachedDocs = await control.findAll(control.ctx, type.of, { attachedTo: task._id })
      for (const it of attachedDocs) {
        res.push(
          control.txFactory.createTxCollectionCUD(
            it.attachedToClass,
            it.attachedTo,
            it.space,
            it.collection,
            control.txFactory.createTxRemoveDoc(it._class, it.space, it._id)
          )
        )
      }
    } else {
      const key = f.mixin != null ? `${f.mixin}.${f.fieldKey}` : f.fieldKey
      unset[key] = true
    }
  }

  if (Object.keys(unset).length > 0) {
    res.push(control.txFactory.createTxUpdateDoc(task._class, task.space, task._id, { $unset: unset }))
  }

  return res.map((it) => ({ ...it, space: core.space.Tx }))
}

export function isCollectionOrArrAttribute (hierarchy: Hierarchy, attr: AnyAttribute): boolean {
  if (attr?.type?._class == null) return false
  return (
    hierarchy.isDerived(attr.type._class, core.class.Collection) ||
    hierarchy.isDerived(attr.type._class, core.class.ArrOf)
  )
}

async function createAttachedDoc (
  control: TriggerControl,
  targetClass: Ref<Class<Task>>,
  taskId: Ref<Task>,
  fieldKey: string,
  rawItem: any
): Promise<Data<AttachedDoc> | undefined> {
  if (fieldKey === 'collaborators') {
    const c: Data<Collaborator> = {
      attachedTo: taskId,
      attachedToClass: targetClass,
      collection: 'collaborators',
      collaborator: String(rawItem) as AccountUuid
    }
    return c
  } else if (fieldKey === 'labels') {
    const element = (await control.findAll(control.ctx, tags.class.TagElement, { _id: rawItem }))[0]
    if (element == null) return undefined
    const l: Data<TagReference> = {
      attachedTo: taskId,
      attachedToClass: targetClass,
      collection: 'labels',
      tag: rawItem,
      color: element.color,
      title: element.title
    }
    return l
  }
}

function isMatch (d: AttachedDoc, rawItem: unknown): boolean {
  if (d._id === rawItem) return true
  if (d.collection === 'collaborators') {
    return (d as Collaborator).collaborator === rawItem
  }
  if (d.collection === 'labels') {
    return (d as TagReference).tag === rawItem
  }
  return false
}

export async function updateCollectionOrArrField (
  control: TriggerControl,
  attr: AnyAttribute,
  targetClass: Ref<Class<Task>>,
  task: Task,
  config: UpdateFieldValueConfig,
  currentTxes: Tx[] = []
): Promise<Tx[]> {
  const h = control.hierarchy
  if (attr?.type?._class == null) return []

  if (h.isDerived(attr.type._class, core.class.Collection)) {
    return await updateCollectionField(control, attr, targetClass, task, config, currentTxes)
  } else if (h.isDerived(attr.type._class, core.class.ArrOf)) {
    return await updateArrField(control, attr, targetClass, task, config)
  }

  return []
}

export async function updateCollectionField (
  control: TriggerControl,
  attr: AnyAttribute,
  targetClass: Ref<Class<Task>>,
  task: Task,
  config: UpdateFieldValueConfig,
  currentTxes: Tx[] = []
): Promise<Tx[]> {
  const type = attr.type as Collection<AttachedDoc>

  const v = await resolveValue(config.value, task, control)
  if (v === undefined) return []

  const isCurrentUserPreset = config.value.type === 'preset' && config.value.preset === '$currentUser'
  const currentAccountUuid = control.ctx.contextData.account.uuid

  const rawItems = Array.isArray(v) ? v : v != null && v !== '' ? [v] : []
  const items = isCurrentUserPreset ? [currentAccountUuid] : rawItems.filter(notEmpty)

  const operation = config.operation ?? 'add'
  if (operation !== 'set' && items.length === 0) return []

  const res: Tx[] = []
  const dbCollection = (await control.findAll(control.ctx, type.of, { attachedTo: task._id })) as AttachedDoc[]
  const currentCollection: AttachedDoc[] = [...dbCollection]

  for (const _tx of currentTxes) {
    if (!TxProcessor.isExtendsCUD(_tx._class)) continue
    const cudTx = _tx as TxCUD<Doc>
    if (cudTx.collection === config.fieldKey && cudTx.attachedTo === task._id) {
      if (cudTx._class === core.class.TxRemoveDoc) {
        const idx = currentCollection.findIndex((d) => d._id === cudTx.objectId)
        if (idx >= 0) {
          currentCollection.splice(idx, 1)
        }
      } else if (cudTx._class === core.class.TxCreateDoc) {
        currentCollection.push(TxProcessor.createDoc2Doc(cudTx as TxCreateDoc<AttachedDoc>))
      }
    }
  }

  if (operation === 'set') {
    for (const doc of currentCollection) {
      const removeTx = control.txFactory.createTxRemoveDoc(doc._class, doc.space, doc._id)
      res.push(
        control.txFactory.createTxCollectionCUD(
          doc.attachedToClass,
          doc.attachedTo,
          doc.space,
          doc.collection,
          removeTx
        )
      )
    }

    for (const _item of items) {
      const createData = await createAttachedDoc(control, targetClass, task._id, config.fieldKey, _item)
      if (createData == null) continue
      const createTx = control.txFactory.createTxCreateDoc(type.of, task.space, createData)
      res.push(control.txFactory.createTxCollectionCUD(targetClass, task._id, task.space, config.fieldKey, createTx))
    }
  } else if (operation === 'add') {
    for (const _item of items) {
      if (currentCollection.some((d) => isMatch(d, _item))) continue
      const createDoc = await createAttachedDoc(control, targetClass, task._id, config.fieldKey, _item)
      if (createDoc == null) continue
      const createTx = control.txFactory.createTxCreateDoc(type.of, task.space, createDoc)
      res.push(control.txFactory.createTxCollectionCUD(targetClass, task._id, task.space, config.fieldKey, createTx))
    }
  } else if (operation === 'remove') {
    const removedIds = new Set<string>()
    for (const _item of items) {
      const matchDocs = currentCollection.filter((d) => !removedIds.has(d._id) && isMatch(d, _item))
      for (const doc of matchDocs) {
        removedIds.add(doc._id)
        const removeTx = control.txFactory.createTxRemoveDoc(doc._class, doc.space, doc._id)
        res.push(
          control.txFactory.createTxCollectionCUD(
            doc.attachedToClass,
            doc.attachedTo,
            doc.space,
            doc.collection,
            removeTx
          )
        )
      }
    }
  }

  return res
}

export async function updateArrField (
  control: TriggerControl,
  attr: AnyAttribute,
  targetClass: Ref<Class<Task>>,
  task: Task,
  config: UpdateFieldValueConfig
): Promise<Tx[]> {
  const h = control.hierarchy
  const v = await resolveValue(config.value, task, control)
  if (v === undefined) return []

  const isCurrentUserPreset = config.value.type === 'preset' && config.value.preset === '$currentUser'
  const currentUser = isCurrentUserPreset ? await getCurrentUser(control) : undefined
  const currentAccountUuid = control.ctx.contextData.account.uuid

  const key = config.fieldKey
  const rawItems = Array.isArray(v) ? v : v != null && v !== '' ? [v] : []
  let items = rawItems.filter(notEmpty)

  if (items.length === 0 && currentUser != null) {
    items = [currentUser]
  }

  const arrType = attr.type as ArrOf<PropertyType>
  const elemClass = typeof arrType.of === 'object' ? (arrType.of as any)?._class : arrType.of
  if (
    isCurrentUserPreset &&
    currentAccountUuid != null &&
    (elemClass === core.class.TypeAccountUuid || elemClass === 'core:class:TypeAccountUuid')
  ) {
    items = [currentAccountUuid]
  }

  const isMixin = config.mixin != null || (targetClass !== task._class && h.isMixin(targetClass))
  const targetDoc = isMixin && h.hasMixin(task, targetClass) ? h.as(task, targetClass) : task

  const currentArr: any[] = Array.isArray((targetDoc as any)?.[key]) ? [...(targetDoc as any)[key]] : []

  const operation = config.operation ?? 'add'
  if (operation !== 'set' && items.length === 0) return []

  const isArrMatch = (a: any, b: any): boolean => {
    if (a === b) return true
    if (a == null || b == null) return false
    if (currentUser != null && (isCurrentUserPreset || b === currentUser) && a === currentUser) {
      return true
    }
    if (typeof a === 'object' && typeof b === 'object') {
      if (a._id != null && b._id != null && a._id === b._id) return true
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch {
        return false
      }
    }
    if (typeof a === 'object' && a._id != null && (typeof b === 'string' || typeof b === 'number')) {
      return a._id === b
    }
    if (typeof b === 'object' && b._id != null && (typeof a === 'string' || typeof a === 'number')) {
      return b._id === a
    }
    return false
  }

  if (operation === 'add') {
    const toAdd = items.filter((item) => !currentArr.some((existing) => isArrMatch(existing, item)))
    if (toAdd.length === 0) return []
    const uniqueToAdd = toAdd.filter((item, idx) => toAdd.findIndex((other) => isArrMatch(item, other)) === idx)
    const pushValue = uniqueToAdd.length === 1 ? uniqueToAdd[0] : { $each: uniqueToAdd, $position: currentArr.length }

    if (isMixin) {
      const mixinUpdate: MixinUpdate<Task, Task> = { $push: { [key]: pushValue } }
      return [control.txFactory.createTxMixin(task._id, task._class, task.space, targetClass, mixinUpdate)]
    } else {
      const update: DocumentUpdate<Task> = { $push: { [key]: pushValue } }
      return [control.txFactory.createTxUpdateDoc(task._class, task.space, task._id, update)]
    }
  } else if (operation === 'remove') {
    if (currentArr.length === 0) return []
    const toRemove = currentArr.filter((existing) => items.some((item) => isArrMatch(existing, item)))
    if (toRemove.length === 0) return []
    const uniqueToRemove = toRemove.filter(
      (item, idx) => toRemove.findIndex((other) => isArrMatch(item, other)) === idx
    )
    const pullValue = uniqueToRemove.length === 1 ? uniqueToRemove[0] : { $in: uniqueToRemove }

    if (isMixin) {
      const mixinUpdate: MixinUpdate<Task, Task> = { $pull: { [key]: pullValue } }
      return [control.txFactory.createTxMixin(task._id, task._class, task.space, targetClass, mixinUpdate)]
    } else {
      const update: DocumentUpdate<Task> = { $pull: { [key]: pullValue } }
      return [control.txFactory.createTxUpdateDoc(task._class, task.space, task._id, update)]
    }
  } else if (operation === 'set') {
    const uniqueItems = items.filter((item, idx) => items.findIndex((other) => isArrMatch(item, other)) === idx)
    if (currentArr.length === uniqueItems.length && currentArr.every((el, i) => isArrMatch(el, uniqueItems[i]))) {
      return []
    }

    if (isMixin) {
      const mixinUpdate: MixinUpdate<Task, Task> = { [key]: uniqueItems }
      return [control.txFactory.createTxMixin(task._id, task._class, task.space, targetClass, mixinUpdate)]
    } else {
      const update: DocumentUpdate<Task> = { [key]: uniqueItems }
      return [control.txFactory.createTxUpdateDoc(task._class, task.space, task._id, update)]
    }
  }

  return []
}
