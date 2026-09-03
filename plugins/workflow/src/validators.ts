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
  AnyAttribute,
  AttachedDoc,
  Doc,
  DocumentUpdate,
  Hierarchy,
  notEmpty,
  Ref,
  RefTo,
  Status,
  Tx,
  type TxCUD,
  TxCreateDoc,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import task, { type Task, TaskType } from '@hcengineering/task'
import tracker, { type Issue, type TimeSpendReport } from '@hcengineering/tracker'
import { type IntlString, translate } from '@hcengineering/platform'
import { isEmptyMarkup } from '@hcengineering/text'

import workflow from './plugin'
import {
  FieldRequiredProps,
  type ValidationResult,
  ValidatorClient,
  ValidatorContext,
  ValidatorFunc,
  type WorkflowTransition
} from './schema'

export async function isEmptyAttribute (
  h: Hierarchy,
  task: Task,
  attribute: AnyAttribute,
  value: any,
  txes: Tx[] = [],
  client?: ValidatorClient
): Promise<boolean> {
  if (h.isDerived(attribute.type._class, core.class.RefTo)) {
    if (value == null) return true
    const type = attribute.type as RefTo<Doc>
    if (h.isDerived(type.to, tracker.class.Issue) && value === tracker.ids.NoParent) {
      return true
    }
  }

  if (h.isDerived(attribute.type._class, tracker.class.TypeReportedTime)) {
    return await isEmptyReportedTime(h, task, value, txes, client)
  }

  if (h.isDerived(attribute.type._class, core.class.Collection)) {
    const createdIds = new Set<string>()
    const removedIds = new Set<string>()

    for (const it of txes) {
      if (it._class === core.class.TxCreateDoc) {
        const createTx = it as TxCreateDoc<AttachedDoc>
        const doc = TxProcessor.createDoc2Doc(createTx)
        const attachedTo = doc.attachedTo
        const collection = doc.collection
        if (attachedTo === task._id && collection === attribute.name) {
          createdIds.add(createTx.objectId)
          removedIds.delete(createTx.objectId)
        }
      } else if (it._class === core.class.TxRemoveDoc) {
        const removeTx = it as TxRemoveDoc<AttachedDoc>
        const attachedTo = removeTx.attachedTo
        const collection = removeTx.collection
        if (attachedTo === task._id && collection === attribute.name) {
          if (createdIds.has(removeTx.objectId)) {
            createdIds.delete(removeTx.objectId)
          } else {
            removedIds.add(removeTx.objectId)
          }
        }
      }
    }

    if (Array.isArray(value)) {
      return value.length === 0
    }

    if (typeof value === 'object' && value !== null) {
      return Object.keys(value).length === 0
    }

    const _count = Number(value)
    const count = Number.isInteger(_count) ? _count : 0
    const effectiveCount = count + createdIds.size - removedIds.size
    return effectiveCount <= 0
  }

  if (value == null) return true

  if (
    h.isDerived(attribute.type._class, core.class.TypeCollaborativeDoc) ||
    h.isDerived(attribute.type._class, core.class.TypeMarkup)
  ) {
    return isEmptyMarkup(value)
  }

  return isEmptyValue(value)
}

/**
 * `reportedTime` on an issue is maintained by a server trigger that sums up attached
 * `TimeSpendReport` documents. When time is reported during a transition screen or in a batch tx,
 * new `TimeSpendReport` records are created in `txes` while the task's own `reportedTime`
 * attribute has not been updated by the trigger yet. We compute the effective reported time
 * by combining the task's base time (or draft payload) with any report CUD operations in `txes`.
 */
async function isEmptyReportedTime (
  h: Hierarchy,
  task: Task,
  value: any,
  txes: Tx[],
  client?: ValidatorClient
): Promise<boolean> {
  const createdReports = new Map<string, number>()
  const updatedPastReports = new Map<Ref<TimeSpendReport>, number>()
  const removedPastReportIds: Array<Ref<TimeSpendReport>> = []

  for (const _tx of txes) {
    if (!TxProcessor.isExtendsCUD(_tx._class)) continue

    const tx = _tx as TxCUD<Doc>

    if (tx.attachedTo !== task._id) continue
    if (tx.objectClass !== tracker.class.TimeSpendReport && tx.collection !== 'reports') continue

    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<TimeSpendReport>
      const report = TxProcessor.createDoc2Doc(createTx)

      createdReports.set(createTx.objectId, parseNumber(report.value))
    } else if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<TimeSpendReport>
      const newVal = getUpdatedFieldValue(updateTx.operations, 'value')

      if (newVal != null) {
        if (createdReports.has(updateTx.objectId)) {
          createdReports.set(updateTx.objectId, parseNumber(newVal))
        } else {
          updatedPastReports.set(updateTx.objectId, parseNumber(newVal))
        }
      }
    } else if (tx._class === core.class.TxRemoveDoc) {
      const removeTx = tx as TxRemoveDoc<TimeSpendReport>

      if (createdReports.has(removeTx.objectId)) {
        createdReports.delete(removeTx.objectId)
      } else {
        removedPastReportIds.push(removeTx.objectId)
      }
    }
  }

  let createdSum = 0
  for (const v of createdReports.values()) {
    createdSum += v
  }

  let pastDelta = 0
  if (client != null && (removedPastReportIds.length > 0 || updatedPastReports.size > 0)) {
    const pastIds = [...removedPastReportIds, ...Array.from(updatedPastReports.keys())]
    const pastDocs = await client.findAll(tracker.class.TimeSpendReport, { _id: { $in: pastIds } })
    for (const doc of pastDocs) {
      if (removedPastReportIds.includes(doc._id)) {
        pastDelta -= parseNumber((doc as any).value)
      }
      const newReportVal = updatedPastReports.get(doc._id)
      if (newReportVal !== undefined) {
        pastDelta += newReportVal - parseNumber(doc.value)
      }
    }
  }

  let baseValue = 0
  if (typeof value === 'number') {
    baseValue = isNaN(value) ? 0 : value
  } else if (typeof value === 'object' && value !== null) {
    if ('reportedTime' in value && typeof value.reportedTime === 'number') {
      baseValue = isNaN(value.reportedTime) ? 0 : value.reportedTime
    } else if ('value' in value && typeof value.value === 'number') {
      baseValue = isNaN(value.value) ? 0 : value.value
    } else if (Array.isArray(value.draftReports)) {
      for (const r of value.draftReports) {
        baseValue += parseNumber(r.value)
      }
    } else {
      baseValue = parseNumber((task as Issue).reportedTime)
    }
  } else {
    baseValue = parseNumber((task as Issue).reportedTime)
  }

  const effectiveReportedTime = baseValue + createdSum + pastDelta
  return effectiveReportedTime <= 0 || isNaN(effectiveReportedTime)
}

function parseNumber (val: unknown): number {
  const num = Number(val)
  return isNaN(num) ? 0 : num
}

function getUpdatedFieldValue<T extends Doc, K extends keyof T> (
  operations: DocumentUpdate<T>,
  field: K
): T[K] | undefined {
  if (field in operations) {
    return (operations as any)[field]
  }
  const setOps = (operations as any).$set
  if (setOps != null && typeof setOps === 'object' && field in setOps) {
    return setOps[field]
  }
  return undefined
}

function isEmptyValue (value: any): boolean {
  if (value === undefined || value === null) {
    return true
  }
  if (typeof value === 'number') {
    return value === 0 || isNaN(value)
  }
  if (typeof value === 'boolean') {
    return false
  }
  if (typeof value === 'string') {
    return value.trim() === ''
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size === 0
  }
  if (typeof value === 'object') {
    if ('value' in value && Object.keys(value).length === 1) {
      return isEmptyValue(value.value)
    }
    return Object.keys(value).length === 0
  }

  return false
}

export const FieldRequired: ValidatorFunc = async (
  client: ValidatorClient,
  taskDoc: Task,
  transition: WorkflowTransition,
  _props: Record<string, any>,
  context?: ValidatorContext
): Promise<ValidationResult> => {
  const props = _props as FieldRequiredProps | undefined
  const fields = props?.fields ?? []

  if (fields.length === 0) {
    return { ok: true }
  }

  const h = client.getHierarchy()
  for (const f of fields) {
    const fieldKey = f.fieldKey
    if (fieldKey == null || fieldKey === '') continue

    const attribute = h.findAttribute(f.mixin ?? taskDoc._class, fieldKey)

    const val = f.mixin != null ? (h.as(taskDoc, f.mixin) as any)[f.fieldKey] : (taskDoc as any)[f.fieldKey]
    if (attribute == null) continue

    if (await isEmptyAttribute(h, taskDoc, attribute, val, context?.txes, client)) {
      const flow = await getTransitionFlow(client, transition)
      const fieldName = await translate(attribute.label, {})
      return {
        ok: false,
        reason: `Field "${fieldName}" is required for transition ${flow}.`,
        reasonIntl: workflow.string.FieldRequiredError,
        intlParams: { field: fieldName, transition: flow },
        intlParamsNotLocalized: { field: attribute.label }
      }
    }
  }

  return { ok: true }
}

async function getTransitionFlow (client: ValidatorClient, transition: WorkflowTransition): Promise<string> {
  const fromStr =
    transition.from != null && transition.from.length > 0 ? await getStatusNames(client, transition.from) : 'Any'
  const toStr = await getStatusNames(client, [transition.to])
  return `${fromStr} ➜ ${toStr}`
}

async function getStatusNames (client: ValidatorClient, statusIds: Ref<Status>[]): Promise<string> {
  if (statusIds.length === 0) return ''
  const statusDocs: Pick<Status, '_id' | 'name'>[] = await client.findAll(
    core.class.Status,
    { _id: { $in: statusIds } },
    { projection: { _id: 1, name: 1 } }
  )
  const nameMap = new Map(statusDocs.map((s) => [s._id, s.name]))
  const translatedNames = await Promise.all(
    statusIds.map(async (id) => {
      const name = nameMap.get(id) ?? String(id)
      return await translate(name as IntlString, {})
    })
  )
  return translatedNames.join(', ')
}

function checkTaskTypeStatus (
  statusesProp: Record<Ref<TaskType>, Ref<Status>[] | null> | undefined,
  taskTypeId: Ref<TaskType>,
  taskStatus: Ref<Status>
): { ok: true } | { ok: false, allowedStatuses: Ref<Status>[] } {
  if (statusesProp == null) return { ok: true }

  const allowed = statusesProp?.[taskTypeId]
  if (allowed == null) {
    return { ok: true }
  }

  if (Array.isArray(allowed)) {
    const filterAllowed = allowed.filter(notEmpty)
    if (filterAllowed.length === 0) {
      return { ok: true }
    }
    if (filterAllowed.includes(taskStatus)) {
      return { ok: true }
    }
    return { ok: false, allowedStatuses: filterAllowed }
  }

  return { ok: true }
}

export const SubtaskStatus: ValidatorFunc = async (
  client: ValidatorClient,
  taskDoc: Task,
  transition: WorkflowTransition,
  props: Record<string, any>
): Promise<ValidationResult> => {
  const statusesMap = (props.statuses ?? {}) as Record<Ref<TaskType>, Ref<Status>[] | null>
  if (isEmptyValue(statusesMap)) {
    return { ok: true }
  }

  const subtasks: Pick<Task, 'kind' | 'status'>[] = await client.findAll(
    task.class.Task,
    { attachedTo: taskDoc._id },
    { projection: { kind: 1, status: 1 } }
  )
  if (subtasks.length === 0) {
    return { ok: true }
  }

  for (const subtask of subtasks) {
    const check = checkTaskTypeStatus(statusesMap, subtask.kind, subtask.status)
    if (!check.ok) {
      const flow = await getTransitionFlow(client, transition)
      const statusesStr = await getStatusNames(client, check.allowedStatuses)
      return {
        ok: false,
        reason: `Subtasks must be in allowed statuses (${statusesStr}) for transition ${flow}.`,
        reasonIntl: workflow.string.SubtaskStatusError,
        intlParams: { transition: flow, statuses: statusesStr }
      }
    }
  }

  return { ok: true }
}

export const ParentStatus: ValidatorFunc = async (
  client: ValidatorClient,
  taskDoc: Task,
  transition: WorkflowTransition,
  props: Record<string, any>
): Promise<ValidationResult> => {
  const statusesMap = (props.statuses ?? {}) as Record<Ref<TaskType>, Ref<Status>[] | null>
  if (isEmptyValue(statusesMap)) {
    return { ok: true }
  }

  if (taskDoc.attachedTo == null || taskDoc.attachedTo === tracker.ids.NoParent) {
    return { ok: true }
  }

  const parentTasks: Pick<Task, 'kind' | 'status'>[] = await client.findAll(
    task.class.Task,
    { _id: taskDoc.attachedTo as Ref<Task> },
    { projection: { kind: 1, status: 1 } }
  )
  if (parentTasks.length === 0) {
    return { ok: true }
  }

  const parentTask = parentTasks[0]
  const check = checkTaskTypeStatus(statusesMap, parentTask.kind, parentTask.status)
  if (!check.ok) {
    const flow = await getTransitionFlow(client, transition)
    const statusesStr = await getStatusNames(client, check.allowedStatuses)
    return {
      ok: false,
      reason: `Parent task must be in allowed statuses (${statusesStr}) for transition ${flow}.`,
      reasonIntl: workflow.string.ParentStatusError,
      intlParams: { transition: flow, statuses: statusesStr }
    }
  }

  return { ok: true }
}
