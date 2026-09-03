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

import core, { Data, DocumentUpdate, type Ref, SortingOrder, type Status, type TxOperations } from '@hcengineering/core'
import { Project, TaskType, ProjectType, makeRank } from '@hcengineering/task'

import workflow from './plugin'
import type {
  Workflow,
  WorkflowTransition,
  Screen,
  ScreenTab,
  ScreenField,
  Field,
  WorkflowFieldValue,
  WorkflowPresetValue,
  WorkflowThisValue,
  WorkflowParentValue,
  WorkflowConstValue,
  WorkflowValuePreset,
  WorkflowTransformCall,
  AnyRuleConfig
} from './schema'

export async function createWorkflow (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  taskTypeId: Ref<TaskType>,
  name: string
): Promise<Ref<Workflow>> {
  return await client.createDoc(workflow.class.Workflow, core.space.Workspace, {
    name,
    projectType: projectTypeId,
    taskType: taskTypeId
  })
}

export async function removeWorkflow (client: TxOperations, workflowId: Ref<Workflow>): Promise<void> {
  await client.removeDoc(workflow.class.Workflow, core.space.Workspace, workflowId)
}

export async function addTransition (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  name: string,
  from: Ref<Status>[] | null,
  to: Ref<Status>
): Promise<Ref<WorkflowTransition>> {
  const last = await client.findOne(
    workflow.class.WorkflowTransition,
    { attachedTo: workflowId },
    { sort: { rank: SortingOrder.Descending } }
  )
  const rank = makeRank(last?.rank, undefined)
  return await client.addCollection(
    workflow.class.WorkflowTransition,
    core.space.Workspace,
    workflowId,
    workflow.class.Workflow,
    'transitions',
    {
      name,
      from,
      to,
      rank
    }
  )
}

export async function removeTransition (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  transitionId: Ref<WorkflowTransition>
): Promise<void> {
  await client.removeCollection(
    workflow.class.WorkflowTransition,
    core.space.Workspace,
    transitionId,
    workflowId,
    workflow.class.Workflow,
    'transitions'
  )
}

export async function updateTransition (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  transitionId: Ref<WorkflowTransition>,
  data: DocumentUpdate<WorkflowTransition>
): Promise<void> {
  await client.updateCollection(
    workflow.class.WorkflowTransition,
    core.space.Workspace,
    transitionId,
    workflowId,
    workflow.class.Workflow,
    'transitions',
    data
  )
}

type ConfigType = 'validators' | 'requests' | 'postFunctions'

export async function addRuleConfig (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  transitionId: Ref<WorkflowTransition>,
  configType: ConfigType,
  config: AnyRuleConfig
): Promise<void> {
  const transition = await client.findOne(workflow.class.WorkflowTransition, { _id: transitionId })
  if (transition == null) {
    throw new Error(`Transition ${transitionId} not found`)
  }
  const current = transition[configType] ?? []

  const exists = current.some((c) => c.id === config.id)
  if (exists) {
    throw new Error(`${configType} config already exists on transition ${transitionId}`)
  }

  const update: DocumentUpdate<WorkflowTransition> = {
    $push: { [configType]: config }
  }
  await updateTransition(client, workflowId, transitionId, update)
}

export async function removeRuleConfig (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  transitionId: Ref<WorkflowTransition>,
  configType: ConfigType,
  configId: string
): Promise<void> {
  const transition = await client.findOne(workflow.class.WorkflowTransition, { _id: transitionId })
  if (transition == null) {
    throw new Error(`Transition ${transitionId} not found`)
  }
  const update: DocumentUpdate<WorkflowTransition> = {
    $pull: { [configType]: { id: configId } }
  }
  await updateTransition(client, workflowId, transitionId, update)
}

export async function updateRuleConfig (
  client: TxOperations,
  workflowId: Ref<Workflow>,
  transitionId: Ref<WorkflowTransition>,
  configType: ConfigType,
  configId: string,
  data: Partial<Pick<AnyRuleConfig, 'props'>>
): Promise<void> {
  const transition = await client.findOne(workflow.class.WorkflowTransition, { _id: transitionId })
  if (transition == null) {
    throw new Error(`Transition ${transitionId} not found`)
  }
  const update: DocumentUpdate<WorkflowTransition> = {
    $update: {
      [configType]: {
        $query: { id: configId },
        $update: data
      }
    }
  }
  await updateTransition(client, workflowId, transitionId, update)
}

export async function setWorkflow (
  client: TxOperations,
  project: Project,
  taskTypeId: Ref<TaskType>,
  workflowId: Ref<Workflow> | null
): Promise<void> {
  const hierarchy = client.getHierarchy()
  const projectWorkflow = hierarchy.as(project, workflow.mixin.ProjectWorkflow)
  const currentMappings = projectWorkflow.workflows
  const newMappings: Record<Ref<TaskType>, Ref<Workflow>> = { ...currentMappings }
  if (workflowId == null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete newMappings[taskTypeId]
  } else {
    newMappings[taskTypeId] = workflowId
  }

  if (!hierarchy.hasMixin(project, workflow.mixin.ProjectWorkflow)) {
    await client.createMixin(project._id, project._class, project.space, workflow.mixin.ProjectWorkflow, {
      workflows: newMappings
    })
  } else {
    await client.updateMixin(project._id, project._class, project.space, workflow.mixin.ProjectWorkflow, {
      workflows: newMappings
    })
  }
}

export function findTransitionConflict (
  t1: Pick<WorkflowTransition, 'from' | 'to'>,
  t2: Pick<WorkflowTransition, 'from' | 'to'>
): Ref<Status> | null {
  if (t1.to !== t2.to) return null

  const t1From = t1.from == null || t1.from.length === 0 ? null : t1.from
  const t2From = t2.from == null || t2.from.length === 0 ? null : t2.from

  if (t1From === null && t2From === null) {
    return 'null' as unknown as Ref<Status>
  }

  if (t1From !== null && t2From !== null) {
    const intersect = t1From.find((s) => t2From.includes(s))
    return intersect ?? null
  }

  return null
}

export function checkConflict (
  t1: Pick<WorkflowTransition, 'from' | 'to'>,
  t2: Pick<WorkflowTransition, 'from' | 'to'>
): boolean {
  return findTransitionConflict(t1, t2) !== null
}

export interface ConflictInfo {
  transition: WorkflowTransition
  status: Ref<Status>
}

export function getTransitionConflict (
  newTransition: Pick<WorkflowTransition, 'from' | 'to'> & { _id?: Ref<WorkflowTransition> },
  existingTransitions: WorkflowTransition[]
): ConflictInfo | null {
  for (const t of existingTransitions) {
    if (newTransition._id !== undefined && t._id === newTransition._id) continue
    const conflictStatus = findTransitionConflict(newTransition, t)
    if (conflictStatus !== null) {
      return {
        transition: t,
        status: conflictStatus
      }
    }
  }
  return null
}

export function hasTransitionConflict (
  newTransition: Pick<WorkflowTransition, 'from' | 'to'> & { _id?: Ref<WorkflowTransition> },
  existingTransitions: WorkflowTransition[]
): boolean {
  return getTransitionConflict(newTransition, existingTransitions) !== null
}

export function hasSelfTransition (transition: Pick<WorkflowTransition, 'from' | 'to'>): boolean {
  if (transition.to == null || transition.from == null || !Array.isArray(transition.from)) {
    return false
  }
  return transition.from.includes(transition.to)
}

export async function addScreenTab (client: TxOperations, screenId: Ref<Screen>, name: string): Promise<Ref<ScreenTab>> {
  const last = await client.findOne(
    workflow.class.ScreenTab,
    { attachedTo: screenId },
    { sort: { rank: SortingOrder.Descending } }
  )
  const rank = makeRank(last?.rank, undefined)
  return await client.addCollection(
    workflow.class.ScreenTab,
    core.space.Workspace,
    screenId,
    workflow.class.Screen,
    'tabs',
    {
      name,
      rank
    }
  )
}

export async function removeScreenTab (
  client: TxOperations,
  screenId: Ref<Screen>,
  tabId: Ref<ScreenTab>
): Promise<void> {
  await client.removeCollection(
    workflow.class.ScreenTab,
    core.space.Workspace,
    tabId,
    screenId,
    workflow.class.Screen,
    'tabs'
  )
}

export async function addScreenField (
  client: TxOperations,
  tabId: Ref<ScreenTab>,
  data: Omit<Data<ScreenField>, 'collection' | 'attachedTo' | 'attachedToClass' | 'rank'>
): Promise<Ref<ScreenField>> {
  const last = await client.findOne(
    workflow.class.ScreenField,
    { attachedTo: tabId },
    { sort: { rank: SortingOrder.Descending } }
  )
  const rank = makeRank(last?.rank, undefined)
  return await client.addCollection(
    workflow.class.ScreenField,
    core.space.Workspace,
    tabId,
    workflow.class.ScreenTab,
    'fields',
    {
      ...data,
      rank
    }
  )
}

export async function removeScreenField (
  client: TxOperations,
  tabId: Ref<ScreenTab>,
  fieldId: Ref<ScreenField>
): Promise<void> {
  await client.removeCollection(
    workflow.class.ScreenField,
    core.space.Workspace,
    fieldId,
    tabId,
    workflow.class.ScreenTab,
    'fields'
  )
}

// Builder API for Workflow Value Expressions
export const WorkflowValue = {
  preset (preset: WorkflowValuePreset, functions?: WorkflowTransformCall[]): WorkflowPresetValue {
    return { type: 'preset', preset, functions }
  },
  this (field: Field, functions?: WorkflowTransformCall[]): WorkflowThisValue {
    return { ...field, type: 'this', functions }
  },
  parent (field: Field, functions?: WorkflowTransformCall[]): WorkflowParentValue {
    return { ...field, type: 'parent', functions }
  },
  const (value: unknown, functions?: WorkflowTransformCall[]): WorkflowConstValue {
    return { type: 'const', value, functions }
  }
}

// Type Guards
export function isPresetValue (val: WorkflowFieldValue): val is WorkflowPresetValue {
  return val.type === 'preset'
}

export function isThisValue (val: WorkflowFieldValue): val is WorkflowThisValue {
  return val.type === 'this'
}

export function isParentValue (val: WorkflowFieldValue): val is WorkflowParentValue {
  return val.type === 'parent'
}

export function isConstValue (val: WorkflowFieldValue): val is WorkflowConstValue {
  return val.type === 'const'
}
