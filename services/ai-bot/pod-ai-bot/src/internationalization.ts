//
// Copyright © 2026 Intabia Fusion
//

import { aiBotId } from '@hcengineering/ai-bot'
import { addStringsLoader } from '@hcengineering/platform'

import aiBotEn from '@hcengineering/ai-bot-assets/lang/en.json'
import aiBotRu from '@hcengineering/ai-bot-assets/lang/ru.json'

// Register ai-bot string bundles so the pod can translate IntlString server-side
// (e.g. non-personal replies rendered in the space language).
export function registerStringLoaders (): void {
  addStringsLoader(aiBotId, async (lang: string) => (lang === 'ru' ? aiBotRu : aiBotEn))
}
