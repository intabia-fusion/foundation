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

import { SubscriptionStatus } from '@hcengineering/account-client'
import { notifyExpired, setMailSender } from '../notifications'

// Renders the real email (no module mock here — scheduler.test.ts covers when the scheduler sends it,
// this file covers what actually lands in the mailbox).
const ENDED = Date.UTC(2026, 6, 22)
const NOW = ENDED + 60 * 60 * 1000

const config: any = {
  MailFrom: 'platform@intabia.ru',
  FrontUrl: 'https://app.intabia.ru',
  PaymentUrl: undefined // no plan-config lookup: getPlanLabel falls back to the raw plan id
}

const sub: any = {
  id: 'tbank_1',
  provider: 'tbank',
  providerSubscriptionId: '1',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'tier',
  plan: 'business',
  status: SubscriptionStatus.Canceled,
  amount: 49900,
  periodEnd: ENDED,
  providerData: { pan: '430000******0777', recurrent: false }
}

function makeStorage (ws: any = { name: 'Моя компания', url: 'my-company' }): any {
  return {
    getAccountContact: jest.fn().mockResolvedValue({
      name: 'Иван',
      email: 'payer@x.com',
      phone: null,
      locale: 'ru'
    }),
    getWorkspaceInfo: jest.fn().mockResolvedValue(ws)
  }
}

function makeCtx (): any {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

// Capture the message posted to pod-mail.
let sent: any[] = []

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  jest.setSystemTime(NOW)
  sent = []
  // The pod publishes to the notification queue now; capture what the sender is handed.
  setMailSender(async (_ctx: any, to: string, msg: any) => {
    sent.push({ to, ...msg })
  })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('access-ended email: content per kind', () => {
  test('oneoff says access ran out and points at renewing', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('Доступ по тарифу «business» закончился')
    expect(sent[0].text).toContain('закончился 22.07.2026')
    expect(sent[0].text).toContain('бесплатный тариф')
    expect(sent[0].text).toContain(
      'Продлить доступ: https://app.intabia.ru/workbench/my-company/setting/setting/billing'
    )
  })

  test('canceled attributes the end to the user, not to a lapsed payment', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'canceled', ENDED)
    expect(sent[0].subject).toBe('Подписка «business» завершена')
    expect(sent[0].text).toContain('как вы и просили')
    expect(sent[0].text).toContain('Оформить подписку')
  })

  test('the date shown is when access ended, not when the tick ran', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent[0].text).toContain('Дата окончания: 22.07.2026')
  })

  test('no amount or payment method: nothing was charged', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent[0].text).not.toContain('Сумма')
    expect(sent[0].text).not.toContain('Карта')
  })

  test('package family ends the package, it does not fall back to a free plan', async () => {
    const pkg = { ...sub, type: 'package', plan: 'storage-100gb' }
    await notifyExpired(makeCtx(), makeStorage(), config, pkg, 'oneoff', ENDED)
    expect(sent[0].text).toContain('Пакет: storage-100gb')
    expect(sent[0].text).not.toContain('бесплатный тариф')
  })

  test('english locale renders the english copy', async () => {
    const storage = makeStorage()
    storage.getAccountContact.mockResolvedValue({ name: 'John', email: 'payer@x.com', phone: null, locale: 'en' })
    await notifyExpired(makeCtx(), storage, config, sub, 'oneoff', ENDED)
    expect(sent[0].subject).toBe('Your "business" access has ended')
    expect(sent[0].text).toContain('Workspace: Моя компания')
  })

  test('grace says read-only, not free plan', async () => {
    // enforceGracePeriod moves the sub to ReadOnly: data stays readable, editing stops.
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'grace', ENDED)
    expect(sent[0].subject).toBe('Доступ по тарифу «business» приостановлен')
    expect(sent[0].text).toContain('только для чтения')
    expect(sent[0].text).not.toContain('бесплатный тариф')
    expect(sent[0].text).toContain('Оплатить подписку')
  })

  test('grace names the failed payment as the reason', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'grace', ENDED)
    expect(sent[0].text).toContain('так и не прошла')
  })

  test('trial ends on the free plan and points at choosing one', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'trial', ENDED)
    expect(sent[0].subject).toBe('Пробный период закончился')
    expect(sent[0].text).toContain('бесплатный тариф')
    expect(sent[0].text).toContain('Выбрать тариф')
  })

  test('english grace and trial render too', async () => {
    const storage = makeStorage()
    storage.getAccountContact.mockResolvedValue({ name: 'John', email: 'payer@x.com', phone: null, locale: 'en' })
    await notifyExpired(makeCtx(), storage, config, sub, 'grace', ENDED)
    await notifyExpired(makeCtx(), storage, config, sub, 'trial', ENDED)
    expect(sent[0].subject).toBe('Your "business" access is suspended')
    expect(sent[0].text).toContain('read-only')
    expect(sent[1].subject).toBe('Your trial has ended')
  })
})

describe('access-ended email: workspace row', () => {
  test('name is the link text, url is the href', async () => {
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent[0].html).toContain('<a href="https://app.intabia.ru/workbench/my-company">Моя компания</a>')
  })

  test('workspace lookup failed -> row is dropped, no raw uuid leaks to the customer', async () => {
    await notifyExpired(makeCtx(), makeStorage(null), config, sub, 'oneoff', ENDED)
    expect(sent[0].text).not.toContain('Рабочее пространство: ')
    expect(sent[0].text).not.toContain('ws-1')
  })

  test('a name with html characters is escaped', async () => {
    const storage = makeStorage({ name: '<b>A&B</b> "x"', url: 'ab' })
    await notifyExpired(makeCtx(), storage, config, sub, 'oneoff', ENDED)
    expect(sent[0].html).toContain('&lt;b&gt;A&amp;B&lt;/b&gt; &quot;x&quot;')
    expect(sent[0].html).not.toContain('<b>A&B</b>')
  })
})

describe('access-ended email: the CTA opens this workspace', () => {
  test('the link points at the billing settings of the workspace the mail is about', async () => {
    // Route shape: [workbenchId, workspaceUrl, settingId, category] — a bare /billing lands nowhere.
    await notifyExpired(makeCtx(), makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent[0].html).toContain('href="https://app.intabia.ru/workbench/my-company/setting/setting/billing"')
  })

  test('another workspace of the same owner gets its own link', async () => {
    const storage = makeStorage({ name: 'Вторая', url: 'second-ws' })
    await notifyExpired(makeCtx(), storage, config, sub, 'canceled', ENDED)
    expect(sent[0].text).toContain('https://app.intabia.ru/workbench/second-ws/setting/setting/billing')
  })

  test('workspace unknown -> front root, never a dead deep link', async () => {
    await notifyExpired(makeCtx(), makeStorage(null), config, sub, 'oneoff', ENDED)
    expect(sent[0].text).toContain('Продлить доступ: https://app.intabia.ru')
    expect(sent[0].text).not.toContain('/setting/billing')
  })
})

describe('access-ended email: skips', () => {
  test('no sender wired -> nothing is sent, and it is warned about', async () => {
    // The sender is wired unconditionally from the queue producer, so reaching this branch on a live
    // pod means startup went wrong — loud enough to notice, not an info line that scrolls past.
    setMailSender(undefined)
    const ctx = makeCtx()
    await notifyExpired(ctx, makeStorage(), config, sub, 'oneoff', ENDED)
    expect(sent).toHaveLength(0)
    expect(ctx.warn).toHaveBeenCalled()
    expect(ctx.info).not.toHaveBeenCalled()
  })

  test('no email on the account -> nothing is sent', async () => {
    const storage = makeStorage()
    storage.getAccountContact.mockResolvedValue({ name: null, email: null, phone: null, locale: 'ru' })
    await notifyExpired(makeCtx(), storage, config, sub, 'oneoff', ENDED)
    expect(sent).toHaveLength(0)
  })

  test('a mail-service failure is swallowed, never thrown at the scheduler', async () => {
    setMailSender(async () => {
      throw new Error('queue unavailable')
    })
    const ctx = makeCtx()
    await expect(notifyExpired(ctx, makeStorage(), config, sub, 'oneoff', ENDED)).resolves.toBeUndefined()
    expect(ctx.error).toHaveBeenCalled()
  })
})
