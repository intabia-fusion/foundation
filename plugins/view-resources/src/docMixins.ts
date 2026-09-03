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
  type Class,
  type Doc,
  type Hierarchy,
  type Mixin,
  type Rank,
  type Ref,
  notEmpty
} from '@hcengineering/core'
import { toRank } from '@hcengineering/rank'
import setting from '@hcengineering/setting'

/**
 * Mixins to show for a document, ordered by {@link setting.mixin.ClassifierOrder} rank.
 * Extracted from `utils.ts` so it stays unit testable - `utils.ts` pulls in `.svelte` modules.
 * @public
 */
export function filterDocMixins (
  hierarchy: Hierarchy,
  object: Doc,
  showAllMixins = false,
  ignoreMixins = new Set<Ref<Mixin<Doc>>>(),
  objectClass?: Ref<Class<Doc>>
): Array<Mixin<Doc>> {
  if (object === undefined) {
    return []
  }

  const descendants = hierarchy
    .getDescendants(core.class.Doc)
    .map((p) => hierarchy.findClass(p))
    .filter(notEmpty)
  const _class = objectClass ?? object._class

  const rankOf = (m: Class<Doc>): Rank =>
    (hierarchy.hasMixin(m, setting.mixin.ClassifierOrder)
      ? hierarchy.as(m, setting.mixin.ClassifierOrder).rank
      : undefined) ??
    toRank(m._id) ??
    ''

  return descendants
    .filter(
      (descendant) =>
        descendant.kind === ClassifierKind.MIXIN &&
        !ignoreMixins.has(descendant._id) &&
        (hierarchy.hasMixin(object, descendant._id) ||
          (showAllMixins &&
            hierarchy.isDerived(_class, hierarchy.getBaseClass(descendant._id)) &&
            (descendant.extends !== undefined && hierarchy.isMixin(descendant.extends) // Parent mixin stamped, or (lazy task-type data mixin) applicable to this class.
              ? hierarchy.hasMixin(object, descendant.extends) ||
                hierarchy.isDerived(_class, hierarchy.getBaseClass(descendant.extends))
              : true)))
    )
    .sort((a, b) => rankOf(a).localeCompare(rankOf(b)))
}
