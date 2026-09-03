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

export interface AIMemory {
  sharedPrompt: string
  personalContext: string
}

/** Resolve per-user personal context: Preference > legacy blob (migrate=true) > employee name seed. */
export function resolveMemory (
  pref: { personalContext?: string } | undefined,
  blobMemory: { userMemory?: string, assistantMemory?: string } | undefined,
  employeeName: string | undefined
): { personalContext: string, migrate: boolean } {
  if (pref !== undefined) {
    return { personalContext: pref.personalContext ?? '', migrate: false }
  }
  if (blobMemory !== undefined) {
    return { personalContext: blobMemory.userMemory ?? blobMemory.assistantMemory ?? '', migrate: true }
  }
  return {
    personalContext: employeeName !== undefined && employeeName !== '' ? `User name: ${employeeName}` : '',
    migrate: false
  }
}
