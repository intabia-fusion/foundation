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

/** Shared by the AI and ASR level registries: resolve a requested level to (provider, model),
 * exact match first, else nearest by `order` (closest lower/cheaper, then closest higher). */
export function resolveByOrder<
  TLevel extends string,
  TModel extends { order: number },
  TProvider extends { levels: Partial<Record<TLevel, TModel>> }
> (
  level: TLevel,
  registry: TProvider[],
  available: Array<{ level: TLevel, order: number }>,
  notFoundMessage: string
): { provider: TProvider, level: TLevel, model: TModel } {
  const at = (lvl: TLevel): { provider: TProvider, level: TLevel, model: TModel } | undefined => {
    for (const provider of registry) {
      const model = provider.levels[lvl]
      if (model !== undefined) return { provider, level: lvl, model }
    }
    return undefined
  }

  const exact = at(level)
  if (exact !== undefined) return exact

  if (available.length === 0) {
    throw new Error(notFoundMessage)
  }

  // Requested level not served. Pick nearest by order: prefer closest lower,
  // else closest higher. Unknown requested level (no order) -> weakest available.
  const reqOrder = available.find((l) => l.level === level)?.order
  if (reqOrder === undefined) {
    const fallback = at(available[0].level)
    if (fallback !== undefined) return fallback
  } else {
    const lower = available.filter((l) => l.order < reqOrder).pop()
    const higher = available.find((l) => l.order > reqOrder)
    const pick = lower ?? higher
    if (pick !== undefined) {
      const r = at(pick.level)
      if (r !== undefined) return r
    }
  }

  throw new Error(notFoundMessage)
}
