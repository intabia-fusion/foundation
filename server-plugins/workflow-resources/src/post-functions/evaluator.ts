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

import { type TriggerControl } from '@hcengineering/server-core'
import { type Task } from '@hcengineering/task'
import workflow, { type WorkflowFieldValue, WorkflowValueFunction } from '@hcengineering/workflow'

import tracker from '@hcengineering/tracker'
import { Class, Doc, Mixin, Ref } from '@hcengineering/core'
import contact, { Person, SocialIdentityRef } from '@hcengineering/contact'

import { applyValueFunctions } from './transforms'

export async function resolveValue (val: WorkflowFieldValue, task: Task, control: TriggerControl): Promise<unknown> {
  try {
    if (val == null) return undefined

    const functions = getFunctions(control, val)
    let result = await evaluateWorkflowValue(val, task, control)
    if (result == null) return undefined

    const transforms = functions.filter((it) => it.type === 'transform')
    if (transforms.length > 0 && val.functions != null) {
      result = applyValueFunctions(val.functions, result, transforms)
    }

    return result
  } catch (error) {
    control.ctx.error('Failed to resolve workflow value', { error })
  }
}

function getFunctions (control: TriggerControl, val: WorkflowFieldValue): WorkflowValueFunction[] {
  if (val.functions == null || val.functions.length === 0) return []
  const functions = val.functions.map((it) => it.func)
  return control.modelDb.findAllSync(workflow.class.WorkflowValueFunction, { _id: { $in: functions } })
}

async function evaluateWorkflowValue (
  parsed: WorkflowFieldValue,
  task: Task,
  control: TriggerControl
): Promise<unknown> {
  switch (parsed.type) {
    case 'preset':
      return await evalPreset(parsed.preset, control)
    case 'this':
      return evalThisField(control, task, parsed.fieldKey, parsed.mixin)
    case 'parent':
      return await evalParentField(control, task, parsed.fieldKey, parsed.mixin)
    case 'const':
      return parsed.value
    default:
      return undefined
  }
}

async function evalPreset (preset: string, control: TriggerControl): Promise<any> {
  if (preset === '$currentUser') {
    return await getCurrentUser(control)
  }
  if (preset === '$now' || preset === '$today') {
    return Date.now()
  }
}

export async function getCurrentUser (control: TriggerControl): Promise<Ref<Person> | undefined> {
  return (
    await control.findAll(control.ctx, contact.class.SocialIdentity, {
      _id: control.ctx.contextData.account.primarySocialId as SocialIdentityRef
    })
  )[0]?.attachedTo
}

function evalThisField (control: TriggerControl, task: Task, fieldKey: string, mixin?: Ref<Mixin<Doc>>): unknown {
  if (fieldKey === '') return undefined
  return getDocFieldValue(control, task, fieldKey, mixin)
}

async function evalParentField (
  control: TriggerControl,
  task: Task,
  fieldKey: string,
  mixin?: Ref<Mixin<Doc>>
): Promise<unknown> {
  if (
    task.attachedTo == null ||
    task.attachedToClass == null ||
    task.attachedTo === tracker.ids.NoParent ||
    fieldKey === ''
  ) {
    return undefined
  }

  try {
    const parent = (await control.findAll(control.ctx, task.attachedToClass, { _id: task.attachedTo }, { limit: 1 }))[0]
    if (parent == null) return undefined
    return getDocFieldValue(control, parent, fieldKey, mixin)
  } catch (ex) {
    control.ctx.error('[UpdateFieldValue] Failed to fetch parent task field for ' + fieldKey, { error: ex })
  }
}

function getDocFieldValue (control: TriggerControl, doc: Doc, key: string, mixin?: Ref<Class<Mixin<Doc>>>): any {
  if (mixin == null) {
    return (doc as any)[key]
  } else {
    const mixinDoc = control.hierarchy.as(doc, mixin)
    return (mixinDoc as any)[key]
  }
}
