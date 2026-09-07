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

import { formatAmount, formatDate, formatDateTime } from '../render'
import { notifyExpired, notifyPaymentSucceeded, notifyUpcoming } from '../notifications'
import { DEFAULT_CURRENCY } from '../types'

describe('formatAmount', () => {
  test('minor units render with two decimals', () => {
    expect(formatAmount(49900, '₽')).toBe('499.00 ₽')
  })

  test('the currency comes from the caller, not from the formatter', () => {
    // plan-config carries `currency` per plan/package; a non-RUB plan must not print roubles.
    expect(formatAmount(49900, '$')).toBe('499.00 $')
    expect(formatAmount(1000, '€')).toBe('10.00 €')
  })

  test('no currency given -> the documented default', () => {
    expect(formatAmount(49900)).toBe(`499.00 ${DEFAULT_CURRENCY}`)
  })

  test('a missing amount is zero, not NaN', () => {
    expect(formatAmount(undefined, '₽')).toBe('0.00 ₽')
  })
})

describe('currency reaches the rendered mail', () => {
  const sub: any = {
    id: 'sub_1',
    workspaceUuid: 'ws-1',
    accountUuid: 'acc-1',
    type: 'tier',
    plan: 'business',
    amount: 49900,
    periodEnd: Date.UTC(2026, 8, 20),
    providerData: { rebillId: 'reb_1' }
  }

  const ctx: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const mailWith = (currency: string, sent: any[]): any => ({
    storage: {
      getAccountContact: async () => ({ name: 'Иван', email: 'payer@x.com', locale: 'ru' }),
      getWorkspaceInfo: async () => ({ name: 'Моя компания', url: 'my-company' }),
      getWorkspaceUrl: async () => 'my-company'
    },
    send: async (_c: any, to: string, msg: any) => {
      sent.push({ to, ...msg })
    },
    planLabel: async (plan: string) => plan,
    planCurrency: async () => currency,
    frontUrl: 'https://app.intabia.ru'
  })

  test('a rouble plan prints roubles', async () => {
    const sent: any[] = []
    await notifyUpcoming(ctx, mailWith('₽', sent), sub, 'recurrent', sub.periodEnd)
    expect(sent[0].text).toContain('499.00 ₽')
  })

  test('a dollar plan prints dollars, not roubles', async () => {
    const sent: any[] = []
    await notifyUpcoming(ctx, mailWith('$', sent), sub, 'recurrent', sub.periodEnd)
    expect(sent[0].text).toContain('499.00 $')
    expect(sent[0].text).not.toContain('₽')
  })
})

describe('access-ended mail', () => {
  const ctx: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const mailWith = (currency: string, sent: any[]): any => ({
    storage: {
      getAccountContact: async () => ({ name: 'Иван', email: 'payer@x.com', locale: 'ru' }),
      getWorkspaceInfo: async () => ({ name: 'Моя компания', url: 'my-company' }),
      getWorkspaceUrl: async () => 'my-company'
    },
    send: async (_c: any, to: string, msg: any) => {
      sent.push({ to, ...msg })
    },
    planLabel: async (plan: string) => plan,
    planCurrency: async () => currency,
    frontUrl: 'https://app.intabia.ru'
  })

  const pkg: any = {
    id: 'sub_pkg',
    workspaceUuid: 'ws-1',
    accountUuid: 'acc-1',
    type: 'package',
    plan: '100gb',
    amount: 100000,
    providerData: {}
  }

  const ENDED = Date.UTC(2026, 7, 20)

  test('the charged amount is shown, in the plan currency', async () => {
    const sent: any[] = []
    await notifyExpired(ctx, mailWith('$', sent), pkg, 'grace', ENDED)
    expect(sent[0].text).toContain('1000.00 $')
    expect(sent[0].text).not.toContain('₽')
  })

  test('a trial has no amount row: it was never charged', async () => {
    const sent: any[] = []
    const trial = { ...pkg, type: 'tier', plan: 'business', amount: undefined }
    await notifyExpired(ctx, mailWith('₽', sent), trial, 'trial', ENDED)
    expect(sent[0].text).not.toContain('Стоимость')
  })

  test('the CTA points at the billing section, which nests setting twice', async () => {
    const sent: any[] = []
    await notifyExpired(ctx, mailWith('₽', sent), pkg, 'grace', ENDED)
    expect(sent[0].text).toContain('https://app.intabia.ru/workbench/my-company/setting/setting/billing')
  })
})

describe('dates are rendered in UTC', () => {
  // 2026-09-07T17:29Z — east of UTC this is already the 8th locally, so a zone-dependent
  // formatter would print both a different time and a different day.
  const paidAt = Date.UTC(2026, 8, 7, 17, 29)

  test('the time is stamped UTC so the reader is not misled', () => {
    expect(formatDateTime(paidAt, 'ru')).toBe('07.09.2026, 17:29 UTC')
  })

  test('the calendar day is the UTC one', () => {
    expect(formatDate(paidAt, 'ru')).toBe('07.09.2026')
  })

  test('a missing timestamp still renders a dash', () => {
    expect(formatDateTime(undefined, 'ru')).toBe('-')
    expect(formatDate(undefined, 'ru')).toBe('-')
  })
})

describe('receipt for a one-time purchase', () => {
  const ctx: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const sent: any[] = []

  const mail: any = {
    storage: {
      getAccountContact: async () => ({ name: 'Иван', email: 'payer@x.com', locale: 'ru' }),
      getWorkspaceInfo: async () => ({ name: 'Моя компания', url: 'my-company' }),
      getWorkspaceUrl: async () => 'my-company'
    },
    send: async (_c: any, to: string, msg: any) => {
      sent.push({ to, ...msg })
    },
    // Mirrors the pods: a purchase label comes from plan-config `purchasables`, not `plans`.
    planLabel: async () => '1М AI-токенов разово',
    planCurrency: async () => '₽',
    frontUrl: 'https://app.intabia.ru'
  }

  const purchase: any = {
    id: 'tbank_1',
    workspaceUuid: 'ws-1',
    accountUuid: 'acc-1',
    type: 'purchase',
    plan: 'ai-tokens-1m',
    amount: 10000,
    periodStart: Date.UTC(2026, 8, 7, 11, 26),
    periodEnd: Date.UTC(2026, 9, 7, 11, 26),
    providerData: { paymentId: '42' }
  }

  beforeAll(async () => {
    await notifyPaymentSucceeded(ctx, mail, purchase, 'purchase')
  })

  test('the wording does not call a one-time purchase a subscription', () => {
    expect(sent[0].text).toContain('Оплата «1М AI-токенов разово» прошла успешно.')
    expect(sent[0].text).not.toContain('подписке')
  })

  test('the row is labelled a purchase, not a plan', () => {
    expect(sent[0].text).toContain('Покупка: 1М AI-токенов разово')
    expect(sent[0].text).not.toContain('Тариф:')
  })

  test('no subscription period is printed: a purchase has none', () => {
    expect(sent[0].text).not.toContain('Период подписки')
  })
})
