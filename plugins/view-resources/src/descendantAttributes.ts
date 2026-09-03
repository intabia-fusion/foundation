// Copyright © 2026 Intabia Fusion
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
import type { BuildModelKey, DescendantAttribute } from '@hcengineering/view'

export function injectDescendantAttributes (
  baseConfig: Array<BuildModelKey | string>,
  descendantAttributes?: DescendantAttribute[] | null
): Array<BuildModelKey | string> {
  if (descendantAttributes == null || descendantAttributes.length === 0) return baseConfig
  const existingKeys = new Set(baseConfig.map((c) => (typeof c === 'string' ? c : c.key)))
  const extras: BuildModelKey[] = descendantAttributes
    .filter((it) => !existingKeys.has(it.key))
    .map((it) => ({
      key: it.key,
      displayProps: { key: it.key, _class: it._class, compression: true, custom: true }
    }))
  if (extras.length === 0) return baseConfig
  return [...baseConfig, ...extras]
}
