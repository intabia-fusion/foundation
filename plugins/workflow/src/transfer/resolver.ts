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

import core, { type Doc, type Ref, type Status, type TxOperations } from '@hcengineering/core'
import task, { type Project, type ProjectType } from '@hcengineering/task'

import workflow from '../plugin'

export const StatusToken = '$status:'
export const TaskTypeToken = '$taskType:'
export const ScreenToken = '$screen:'
export const AttributeToken = '$attr:'

export type TokenPrefix = typeof StatusToken | typeof TaskTypeToken | typeof ScreenToken | typeof AttributeToken

/** Prefixed name tokens used in rule properties trees (props) */
export type StatusTokenString = `${typeof StatusToken}${string}`
export type TaskTypeTokenString = `${typeof TaskTypeToken}${string}`
export type ScreenTokenString = `${typeof ScreenToken}${string}`
export type AttributeTokenString = `${typeof AttributeToken}${string}`

export type DocToken = StatusTokenString | TaskTypeTokenString | ScreenTokenString | AttributeTokenString

export class NameResolver {
  readonly toToken = new Map<Ref<Doc>, DocToken>()
  readonly fromToken = new Map<DocToken, Ref<Doc>>()

  add<T extends Doc>(prefix: TokenPrefix, ref: Ref<T>, name: string): void {
    const token: DocToken = `${prefix}${name}`
    if (!this.toToken.has(ref)) this.toToken.set(ref, token)
    // Two docs can share a name; pick the smallest ref so the same config always resolves the same
    // way, whatever order the query returned.
    const current = this.fromToken.get(token)
    if (current === undefined || ref < current) this.fromToken.set(token, ref)
  }

  getName<T extends Doc>(ref: Ref<T>, prefix: TokenPrefix): string {
    const token = this.toToken.get(ref)
    return token !== undefined && token.startsWith(prefix) ? token.slice(prefix.length) : (ref as string)
  }

  getRef<T extends Doc>(prefix: TokenPrefix, name: string): Ref<T> | undefined {
    return this.fromToken.get(`${prefix}${name}`) as Ref<T> | undefined
  }

  hasRef (ref: Ref<Doc>): boolean {
    return this.toToken.has(ref)
  }

  setRef<T extends Doc>(prefix: TokenPrefix, name: string, ref: Ref<T>): void {
    const token: DocToken = `${prefix}${name}`
    this.fromToken.set(token, ref)
    if (!this.toToken.has(ref)) {
      this.toToken.set(ref, token)
    }
  }
}

/**
 * Replaces refs by name tokens (export) or name tokens by refs (import) anywhere in a props tree,
 * including object keys - `SubtaskStatuses.statuses` is keyed by task type ref.
 */
export function remap (value: any, dict: Map<any, any> | ReadonlyMap<any, any>, unresolved?: string[]): any {
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

/**
 * Builds a NameResolver populated with task types, statuses, and screens available in the given project type.
 * Executes queries concurrently for optimal performance.
 */
export async function buildResolver (client: TxOperations, projectTypeId: Ref<ProjectType>): Promise<NameResolver> {
  const resolver = new NameResolver()

  const [allTaskTypes, allStatuses, screens] = await Promise.all([
    client.findAll(task.class.TaskType, {}),
    client.findAll(core.class.Status, {}),
    client.findAll(workflow.class.Screen, { projectType: projectTypeId })
  ])

  const currentTaskTypes = allTaskTypes.filter((tt) => tt.parent === projectTypeId)
  const currentStatusIds = new Set<Ref<Status>>()
  for (const tt of currentTaskTypes) {
    if (Array.isArray(tt.statuses)) {
      for (const s of tt.statuses) {
        currentStatusIds.add(s)
      }
    }
  }

  // First add external task types
  for (const tt of allTaskTypes) {
    if (tt.parent !== projectTypeId) {
      resolver.add(TaskTypeToken, tt._id, tt.name)
    }
  }

  // Then add current project type task types with absolute priority
  for (const tt of allTaskTypes) {
    if (tt.parent === projectTypeId) {
      resolver.setRef(TaskTypeToken, tt.name, tt._id)
    }
  }

  // First add all external/global statuses
  for (const st of allStatuses) {
    if (!currentStatusIds.has(st._id)) {
      resolver.add(StatusToken, st._id, st.name)
    }
  }

  // Then add current project type statuses with priority (picking smallest ID among them)
  for (const st of allStatuses) {
    if (currentStatusIds.has(st._id)) {
      const token = `${StatusToken}${st.name}` as const
      const current = resolver.fromToken.get(token)
      if (current === undefined || !currentStatusIds.has(current as Ref<Status>) || st._id < (current as Ref<Status>)) {
        resolver.setRef(StatusToken, st.name, st._id)
      }
    }
  }

  for (const sc of screens) {
    resolver.add(ScreenToken, sc._id, sc.name)
  }

  return resolver
}

// `identifier` lives on the tracker Project, not on the task one we query by.
export function identifierOf (project: Project): string {
  return (project as Project & { identifier?: string }).identifier ?? project.name
}

const KIND_BY_PREFIX: Record<TokenPrefix, string> = {
  [StatusToken]: 'status',
  [TaskTypeToken]: 'task type',
  [ScreenToken]: 'screen',
  [AttributeToken]: 'attribute'
}

export function requireRef<T extends Doc> (
  resolver: NameResolver,
  prefix: TokenPrefix,
  name: string,
  kind?: string
): Ref<T> {
  const ref = resolver.getRef<T>(prefix, name)
  if (ref === undefined) {
    const entityKind = kind ?? KIND_BY_PREFIX[prefix] ?? 'entity'
    throw new Error(`Workflow import: unknown ${entityKind} "${name}"`)
  }
  return ref
}
