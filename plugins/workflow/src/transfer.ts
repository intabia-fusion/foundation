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

import core, { generateId, type Class, type Doc, type Ref, type Status, type TxOperations } from '@hcengineering/core'
import task, { type Project, type ProjectType, type Task, type TaskType } from '@hcengineering/task'

import workflow from './plugin'
import type { AnyRuleConfig, Screen, ScreenField, Workflow, WorkflowTransition } from './schema'
import { addScreenField, addScreenTab, addTransition, createWorkflow, setWorkflow } from './utils'

/**
 * Workflow configuration in a portable form: every workspace-specific reference (status, task type,
 * screen) is written by name, so a config exported from one workspace can be imported into another.
 */
export const WorkflowConfigVersion = 1

export interface WorkflowConfig {
  version: number
  screens?: ScreenConfig[]
  workflows: WorkflowConfigEntry[]
  projects?: ProjectWorkflowsConfig[]
}

export interface WorkflowConfigEntry {
  name: string
  /** Task type name inside the project type. */
  taskType: string
  /** Status names allowed as the initial status; empty or absent means any. */
  initialStatuses?: string[]
  transitions?: TransitionConfig[]
}

export interface TransitionConfig {
  name: string
  /** Status names; `null` means "any status". */
  from: string[] | null
  to: string
  requests?: RuleConfig[]
  validators?: RuleConfig[]
  postFunctions?: RuleConfig[]
}

export interface RuleConfig {
  id?: string
  rule: string
  ruleClass: string
  props: Record<string, any>
}

export interface ScreenConfig {
  name: string
  description?: string
  /** Class id of the target task, e.g. `tracker:class:Issue`. */
  targetClass: string
  tabs?: ScreenTabConfig[]
}

export interface ScreenTabConfig {
  name: string
  fields?: ScreenFieldConfig[]
}

export interface ScreenFieldConfig {
  attribute: string
  fieldKey: string
  mixin?: string
  required: boolean
}

export interface ProjectWorkflowsConfig {
  /** Project identifier, e.g. `PRJ`. */
  identifier: string
  /** Task type name to workflow name. */
  workflows: Record<string, string>
}

export interface ImportResult {
  screens: Record<string, Ref<Screen>>
  workflows: Record<string, Ref<Workflow>>
  transitions: Record<string, Ref<WorkflowTransition>>
}

const StatusToken = '$status:'
const TaskTypeToken = '$taskType:'
const ScreenToken = '$screen:'

class NameResolver {
  readonly toToken = new Map<string, string>()
  readonly fromToken = new Map<string, string>()

  add (prefix: string, ref: string, name: string): void {
    const token = `${prefix}${name}`
    if (!this.toToken.has(ref)) this.toToken.set(ref, token)
    // Two docs can share a name; pick the smallest ref so the same config always resolves the same
    // way, whatever order the query returned.
    const current = this.fromToken.get(token)
    if (current === undefined || ref < current) this.fromToken.set(token, ref)
  }
}

/**
 * Replaces refs by name tokens (export) or name tokens by refs (import) anywhere in a props tree,
 * including object keys - `SubtaskStatuses.statuses` is keyed by task type ref.
 */
function remap (value: any, dict: Map<string, string>, unresolved?: string[]): any {
  if (typeof value === 'string') {
    const mapped = dict.get(value)
    if (mapped !== undefined) return mapped
    if (value.startsWith(StatusToken) || value.startsWith(TaskTypeToken) || value.startsWith(ScreenToken)) {
      unresolved?.push(value)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((it) => remap(it, dict, unresolved))
  }
  if (value !== null && typeof value === 'object') {
    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      res[remap(k, dict, unresolved)] = remap(v, dict, unresolved)
    }
    return res
  }
  return value
}

async function buildResolver (client: TxOperations, projectTypeId: Ref<ProjectType>): Promise<NameResolver> {
  const resolver = new NameResolver()

  const taskTypes = await client.findAll(task.class.TaskType, { parent: projectTypeId })
  const statusIds = new Set<Ref<Status>>()
  for (const tt of taskTypes) {
    resolver.add(TaskTypeToken, tt._id, tt.name)
    for (const st of tt.statuses ?? []) statusIds.add(st)
  }
  if (statusIds.size > 0) {
    const statuses = await client.findAll(core.class.Status, { _id: { $in: Array.from(statusIds) } })
    for (const st of statuses) resolver.add(StatusToken, st._id, st.name)
  }
  const screens = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  for (const sc of screens) resolver.add(ScreenToken, sc._id, sc.name)

  return resolver
}

// `identifier` lives on the tracker Project, not on the task one we query by.
function identifierOf (project: Project): string {
  return (project as Project & { identifier?: string }).identifier ?? project.name
}

function exportRules (rules: AnyRuleConfig[] | undefined, resolver: NameResolver): RuleConfig[] | undefined {
  if (rules === undefined || rules.length === 0) return undefined
  // No unresolved list here: export turns refs into tokens, it never has to resolve one.
  return rules.map((r) => ({
    id: r.id,
    rule: r.rule as string,
    ruleClass: r.ruleClass as string,
    props: remap(r.props ?? {}, resolver.toToken)
  }))
}

/**
 * Reads every workflow, screen and project mapping of a project type into a portable JSON config.
 */
export async function exportWorkflowConfig (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>
): Promise<WorkflowConfig> {
  const resolver = await buildResolver(client, projectTypeId)
  const nameOf = (ref: string, prefix: string): string => resolver.toToken.get(ref)?.slice(prefix.length) ?? ref

  const screenDocs = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  const screens: ScreenConfig[] = []
  for (const sc of screenDocs) {
    const tabs = await client.findAll(workflow.class.ScreenTab, { attachedTo: sc._id }, { sort: { rank: 1 } })
    const tabConfigs: ScreenTabConfig[] = []
    for (const tab of tabs) {
      const fields = await client.findAll(workflow.class.ScreenField, { attachedTo: tab._id }, { sort: { rank: 1 } })
      tabConfigs.push({
        name: tab.name,
        fields: fields.map((f) => ({
          attribute: f.attribute as string,
          fieldKey: f.fieldKey,
          mixin: f.mixin as string | undefined,
          required: f.required
        }))
      })
    }
    screens.push({
      name: sc.name,
      description: sc.description,
      targetClass: sc.targetClass as string,
      tabs: tabConfigs
    })
  }

  const workflowDocs = await client.findAll(workflow.class.Workflow, { projectType: projectTypeId })
  const workflows: WorkflowConfigEntry[] = []
  for (const wf of workflowDocs) {
    const transitions = await client.findAll(
      workflow.class.WorkflowTransition,
      { attachedTo: wf._id },
      { sort: { rank: 1 } }
    )
    workflows.push({
      name: wf.name,
      taskType: nameOf(wf.taskType, TaskTypeToken),
      initialStatuses: wf.initialStatuses?.map((s) => nameOf(s, StatusToken)),
      transitions: transitions.map((t) => ({
        name: t.name,
        from: t.from == null ? null : t.from.map((s) => nameOf(s, StatusToken)),
        to: nameOf(t.to, StatusToken),
        requests: exportRules(t.requests, resolver),
        validators: exportRules(t.validators, resolver),
        postFunctions: exportRules(t.postFunctions, resolver)
      }))
    })
  }

  const wfNames = new Map<string, string>(workflowDocs.map((w) => [w._id, w.name]))
  const ttNames = new Map<string, string>()
  for (const [ref, token] of resolver.toToken) {
    if (token.startsWith(TaskTypeToken)) ttNames.set(ref, token.slice(TaskTypeToken.length))
  }
  const projectDocs = await client.findAll(task.class.Project, { type: projectTypeId })
  const projects: ProjectWorkflowsConfig[] = []
  for (const p of projectDocs) {
    const mapping = client.getHierarchy().as(p, workflow.mixin.ProjectWorkflow).workflows
    if (mapping === undefined) continue
    const entries: Record<string, string> = {}
    for (const [ttRef, wfRef] of Object.entries(mapping)) {
      const ttName = ttNames.get(ttRef)
      const wfName = wfNames.get(wfRef as string)
      if (ttName !== undefined && wfName !== undefined) entries[ttName] = wfName
    }
    if (Object.keys(entries).length > 0) {
      projects.push({ identifier: identifierOf(p), workflows: entries })
    }
  }

  return {
    version: WorkflowConfigVersion,
    screens: screens.length > 0 ? screens : undefined,
    workflows,
    projects: projects.length > 0 ? projects : undefined
  }
}

function requireRef<T extends Doc> (resolver: NameResolver, prefix: string, name: string, kind: string): Ref<T> {
  const ref = resolver.fromToken.get(`${prefix}${name}`)
  if (ref === undefined) {
    throw new Error(`Workflow import: unknown ${kind} "${name}"`)
  }
  return ref as Ref<T>
}

function importRules (rules: RuleConfig[] | undefined, resolver: NameResolver): AnyRuleConfig[] | undefined {
  if (rules === undefined || rules.length === 0) return undefined
  const unresolved: string[] = []
  const res = rules.map((r) => ({
    id: r.id ?? generateId(),
    rule: r.rule,
    ruleClass: r.ruleClass,
    props: remap(r.props ?? {}, resolver.fromToken, unresolved)
  })) as unknown as AnyRuleConfig[]
  if (unresolved.length > 0) {
    throw new Error(`Workflow import: unresolved references ${unresolved.join(', ')}`)
  }
  return res
}

/**
 * Creates screens, workflows, transitions and project mappings described by a config. Names that
 * already exist in the project type are reused rather than duplicated, so importing twice is a no-op
 * for screens and workflows but still re-applies the project mapping.
 */
export async function importWorkflowConfig (
  client: TxOperations,
  projectTypeId: Ref<ProjectType>,
  config: WorkflowConfig
): Promise<ImportResult> {
  if (config.version !== WorkflowConfigVersion) {
    throw new Error(`Workflow import: unsupported version ${config.version}`)
  }
  const resolver = await buildResolver(client, projectTypeId)
  const result: ImportResult = { screens: {}, workflows: {}, transitions: {} }

  for (const sc of config.screens ?? []) {
    const existing = await client.findOne(workflow.class.Screen, { projectType: projectTypeId, name: sc.name })
    let screenId: Ref<Screen>
    if (existing !== undefined) {
      screenId = existing._id
    } else {
      screenId = await client.createDoc(workflow.class.Screen, core.space.Workspace, {
        name: sc.name,
        description: sc.description,
        projectType: projectTypeId,
        targetClass: sc.targetClass as Ref<Class<Task>>
      })
      for (const tab of sc.tabs ?? []) {
        const tabId = await addScreenTab(client, screenId, tab.name)
        for (const f of tab.fields ?? []) {
          await addScreenField(client, tabId, {
            attribute: f.attribute as ScreenField['attribute'],
            fieldKey: f.fieldKey,
            mixin: f.mixin as ScreenField['mixin'],
            required: f.required
          })
        }
      }
    }
    result.screens[sc.name] = screenId
    resolver.add(ScreenToken, screenId, sc.name)
  }

  for (const wf of config.workflows) {
    const taskTypeId = requireRef<TaskType>(resolver, TaskTypeToken, wf.taskType, 'task type')
    const existing = await client.findOne(workflow.class.Workflow, { projectType: projectTypeId, name: wf.name })
    const workflowId = existing?._id ?? (await createWorkflow(client, projectTypeId, taskTypeId, wf.name))
    result.workflows[wf.name] = workflowId

    if (wf.initialStatuses !== undefined) {
      const initialStatuses = wf.initialStatuses.map((s) => requireRef<Status>(resolver, StatusToken, s, 'status'))
      await client.updateDoc(workflow.class.Workflow, core.space.Workspace, workflowId, { initialStatuses })
    }

    for (const t of wf.transitions ?? []) {
      const from = t.from == null ? null : t.from.map((s) => requireRef<Status>(resolver, StatusToken, s, 'status'))
      const to = requireRef<Status>(resolver, StatusToken, t.to, 'status')
      const transitionId = await addTransition(client, workflowId, t.name, from, to)
      result.transitions[`${wf.name}/${t.name}`] = transitionId

      const requests = importRules(t.requests, resolver)
      const validators = importRules(t.validators, resolver)
      const postFunctions = importRules(t.postFunctions, resolver)
      if (requests !== undefined || validators !== undefined || postFunctions !== undefined) {
        await client.updateCollection(
          workflow.class.WorkflowTransition,
          core.space.Workspace,
          transitionId,
          workflowId,
          workflow.class.Workflow,
          'transitions',
          { requests, validators, postFunctions }
        )
      }
    }
  }

  for (const pw of config.projects ?? []) {
    const projects = await client.findAll(task.class.Project, { type: projectTypeId })
    const project = projects.find((p) => identifierOf(p) === pw.identifier)
    if (project === undefined) {
      throw new Error(`Workflow import: unknown project "${pw.identifier}"`)
    }
    for (const [ttName, wfName] of Object.entries(pw.workflows)) {
      const taskTypeId = requireRef<TaskType>(resolver, TaskTypeToken, ttName, 'task type')
      const workflowId = result.workflows[wfName]
      if (workflowId === undefined) {
        throw new Error(`Workflow import: unknown workflow "${wfName}"`)
      }
      // Re-read the project each time: setWorkflow merges into the mixin it sees, and the previous
      // iteration has just changed it.
      const current = await client.findOne(task.class.Project, { _id: project._id })
      await setWorkflow(client, current as Project, taskTypeId, workflowId)
    }
  }

  return result
}

/**
 * Removes every workflow and screen of a project type. Intended for tests and for re-importing a
 * config from scratch.
 */
export async function clearWorkflowConfig (client: TxOperations, projectTypeId: Ref<ProjectType>): Promise<void> {
  const workflows = await client.findAll(workflow.class.Workflow, { projectType: projectTypeId })
  for (const wf of workflows) {
    await client.removeDoc(workflow.class.Workflow, core.space.Workspace, wf._id)
  }
  const screens = await client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  for (const sc of screens) {
    await client.removeDoc(workflow.class.Screen, core.space.Workspace, sc._id)
  }
}
