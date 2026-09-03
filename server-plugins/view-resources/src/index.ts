//
// Copyright © 2022 Hardcore Engineering Inc.
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

import core, { AnyAttribute, Class, Doc, Hierarchy, Ref, Tx, TxRemoveDoc } from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'
import view, { Viewlet, ViewletPreference } from '@hcengineering/view'

/**
 * @public
 */
export async function OnCustomAttributeRemove (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    const hierarchy = control.hierarchy
    const ptx = tx as TxRemoveDoc<AnyAttribute>
    if (!checkTx(ptx, hierarchy)) {
      continue
    }
    const attribute = control.removedMap.get(ptx.objectId) as AnyAttribute
    if (attribute === undefined) {
      continue
    }

    const mixinKey = `${attribute.attributeOf}.${attribute.name}`
    const preferences = await control.findAll(control.ctx, view.class.ViewletPreference, {
      space: core.space.Workspace
    })

    const viewlets = await control.findAll(control.ctx, view.class.Viewlet, {
      space: core.space.Model
    })
    const viewletAttachMap = new Map<string, Ref<Class<Doc>>>()
    for (const v of viewlets as unknown as Viewlet[]) {
      if (v._id != null && v.attachTo != null) {
        viewletAttachMap.set(v._id, v.attachTo)
      }
    }

    for (const preference of preferences as unknown as ViewletPreference[]) {
      const viewletClass = viewletAttachMap.get(preference.attachedTo)
      const isTargetClassOrAncestor =
        viewletClass !== undefined && isClassOrAncestor(hierarchy, viewletClass, attribute.attributeOf)

      const pullObject: Record<string, any> = {}

      if (isTargetClassOrAncestor && preference.config?.includes(attribute.name)) {
        pullObject.config = attribute.name
      }

      if (isTargetClassOrAncestor && preference.customAttributes != null) {
        const hasDirect = preference.customAttributes.includes(attribute.name)
        const hasMixin = preference.customAttributes.includes(mixinKey)
        if (hasDirect || hasMixin) {
          const keysToPull = [hasDirect ? attribute.name : null, hasMixin ? mixinKey : null].filter(
            (k): k is string => k !== null
          )
          pullObject.customAttributes = keysToPull.length === 1 ? keysToPull[0] : { $in: keysToPull }
        }
      }

      if (Object.keys(pullObject).length > 0) {
        const updateTx = control.txFactory.createTxUpdateDoc(preference._class, preference.space, preference._id, {
          $pull: pullObject
        })
        result.push(updateTx)
      }

      if (preference.descendantAttributes != null && preference.descendantAttributes.length > 0) {
        const matchingDescendants = preference.descendantAttributes.filter(
          (da) =>
            (da.key === attribute.name || da.key === mixinKey) &&
            isClassOrAncestor(hierarchy, da._class, attribute.attributeOf)
        )

        for (const da of matchingDescendants) {
          const updateTx = control.txFactory.createTxUpdateDoc(preference._class, preference.space, preference._id, {
            $pull: {
              descendantAttributes: { key: da.key, _class: da._class }
            }
          })
          result.push(updateTx)
        }
      }
    }
  }

  return result
}

function isClassOrAncestor (hierarchy: Hierarchy, targetClass: Ref<Class<Doc>>, attributeOf: Ref<Class<Doc>>): boolean {
  if (targetClass === attributeOf) return true
  try {
    if (hierarchy.isDerived(targetClass, attributeOf)) return true
  } catch {}
  try {
    if (hierarchy.getAncestors(targetClass).includes(attributeOf)) return true
  } catch {}
  return false
}

function checkTx (ptx: TxRemoveDoc<AnyAttribute>, hierarchy: Hierarchy): boolean {
  if (ptx._class !== core.class.TxRemoveDoc) {
    return false
  }

  if (!hierarchy.isDerived(ptx.objectClass, core.class.Attribute)) {
    return false
  }
  return true
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnCustomAttributeRemove
  }
})
