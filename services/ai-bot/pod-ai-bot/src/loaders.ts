//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { coreId } from '@hcengineering/core'
import coreEng from '@hcengineering/core/lang/en.json'
import platformEng from '@hcengineering/platform/lang/en.json'

import { addStringsLoader, platformId } from '@hcengineering/platform'

import { aiBotId } from '@hcengineering/ai-bot'
import aiBotEn from '@hcengineering/ai-bot-assets/lang/en.json'
import aiBotRu from '@hcengineering/ai-bot-assets/lang/ru.json'

export function registerLoaders (): void {
  addStringsLoader(coreId, async (lang: string) => coreEng)
  addStringsLoader(platformId, async (lang: string) => platformEng)
  // ai-bot string bundles so the pod can translate IntlString server-side (e.g. non-personal replies).
  addStringsLoader(aiBotId, async (lang: string) => (lang === 'ru' ? aiBotRu : aiBotEn))
}
