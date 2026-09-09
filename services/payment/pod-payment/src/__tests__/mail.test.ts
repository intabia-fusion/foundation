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

import { createPlanCurrencyResolver, createPlanLabelResolver } from '../mail'

// Shape of the real plan-config: one-time purchases live in `purchasables`, not `plans`.
const planConfig = {
  plans: { business: { label: { ru: 'Бизнес', en: 'Business' } } },
  packages: { '100gb': { description: { ru: '100 Гб', en: '100 GB' }, currency: '$' } },
  purchasables: {
    'ai-tokens-1m': { description: { ru: '1М AI-токенов разово', en: '1M AI tokens one-time' }, currency: '₽' }
  }
}

describe('plan label resolver', () => {
  const label = createPlanLabelResolver(planConfig)

  it('resolves a one-time purchase from purchasables', async () => {
    expect(await label('ai-tokens-1m', 'purchase', 'ru')).toBe('1М AI-токенов разово')
    expect(await label('ai-tokens-1m', 'purchase', 'en')).toBe('1M AI tokens one-time')
  })

  it('still resolves tiers and packages', async () => {
    expect(await label('business', 'tier', 'ru')).toBe('Бизнес')
    expect(await label('100gb', 'package', 'ru')).toBe('100 Гб')
  })

  it('falls back to the raw id so a mail is never blocked', async () => {
    expect(await label('unknown-sku', 'purchase', 'ru')).toBe('unknown-sku')
  })
})

describe('plan currency resolver', () => {
  const currency = createPlanCurrencyResolver(planConfig)

  it('reads the currency of a one-time purchase', async () => {
    expect(await currency('ai-tokens-1m', 'purchase')).toBe('₽')
  })

  it('reads the currency of a package', async () => {
    expect(await currency('100gb', 'package')).toBe('$')
  })

  it('falls back to the default when the item has none', async () => {
    expect(await currency('business', 'tier')).toBe('₽')
  })
})
