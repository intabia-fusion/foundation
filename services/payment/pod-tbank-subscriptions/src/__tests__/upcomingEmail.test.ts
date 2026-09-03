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
import { notifyUpcoming } from '../notifications'

// Renders the real email (no module mock here — upcoming.test.ts covers the scheduler's choice of
// reminder, this file covers what actually lands in the mailbox).
const NOW = Date.UTC(2026, 6, 19)
const DUE = Date.UTC(2026, 6, 22)

const config: any = {
  MailUrl: 'http://mail:8097',
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
  status: SubscriptionStatus.Active,
  amount: 49900,
  periodEnd: DUE,
  providerData: { rebillId: 'reb_1', pan: '430000******0777' }
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
  global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }) as any
})

afterEach(() => {
  jest.useRealTimers()
})

describe('upcoming reminder: workspace row', () => {
  test('name is the link text, url is the href', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), config, sub, 'recurrent', DUE)
    expect(sent).toHaveLength(1)
    expect(sent[0].html).toContain('<a href="https://app.intabia.ru/workbench/my-company">Моя компания</a>')
  })

  test('plain text keeps the url next to the name (it cannot be clicked)', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), config, sub, 'recurrent', DUE)
    expect(sent[0].text).toContain('Рабочее пространство: Моя компания (https://app.intabia.ru/workbench/my-company)')
  })

  test('workspace lookup failed -> row is dropped, no raw uuid leaks to the customer', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(null), config, sub, 'recurrent', DUE)
    expect(sent[0].html).not.toContain('Рабочее пространство')
    expect(sent[0].text).not.toContain('ws-1')
  })

  test('a name with html characters is escaped', async () => {
    const storage = makeStorage({ name: '<b>A&B</b> "x"', url: 'ab' })
    await notifyUpcoming(makeCtx(), storage, config, sub, 'recurrent', DUE)
    expect(sent[0].html).toContain('&lt;b&gt;A&amp;B&lt;/b&gt; &quot;x&quot;')
    expect(sent[0].html).not.toContain('<b>A&B</b>')
  })
})

describe('upcoming reminder: content per kind', () => {
  test('recurrent shows the amount and the card', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), config, sub, 'recurrent', DUE)
    expect(sent[0].text).toContain('Сумма списания: 499.00 ₽')
    expect(sent[0].text).toContain('Карта •••• 0777')
    expect(sent[0].subject).toContain('Скоро спишется оплата')
  })

  test('trial shows neither amount nor card', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), config, sub, 'trial', DUE)
    expect(sent[0].text).not.toContain('Сумма списания')
    expect(sent[0].text).not.toContain('Карта')
    expect(sent[0].text).toContain('Дата окончания: 22.07.2026')
  })

  test('oneoff points at renewing, not at an upcoming charge', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), config, sub, 'oneoff', DUE)
    expect(sent[0].text).toContain('Продлить доступ')
    expect(sent[0].text).not.toContain('Сумма списания')
  })

  test('package family uses the package label', async () => {
    const pkg = { ...sub, type: 'package', plan: 'storage-100gb' }
    await notifyUpcoming(makeCtx(), makeStorage(), config, pkg, 'oneoff', DUE)
    expect(sent[0].text).toContain('Пакет: storage-100gb')
  })

  test('english locale renders the english copy', async () => {
    const storage = makeStorage()
    storage.getAccountContact.mockResolvedValue({
      name: 'John',
      email: 'payer@x.com',
      phone: null,
      locale: 'en'
    })
    await notifyUpcoming(makeCtx(), storage, config, sub, 'recurrent', DUE)
    expect(sent[0].text).toContain('Workspace: Моя компания')
    expect(sent[0].subject).toContain('Upcoming charge')
  })
})

describe('upcoming reminder: skips', () => {
  test('mail not configured -> nothing is sent', async () => {
    await notifyUpcoming(makeCtx(), makeStorage(), { ...config, MailUrl: undefined }, sub, 'recurrent', DUE)
    expect(sent).toHaveLength(0)
  })

  test('no email on the account -> nothing is sent', async () => {
    const storage = makeStorage()
    storage.getAccountContact.mockResolvedValue({ name: null, email: null, phone: null, locale: 'ru' })
    await notifyUpcoming(makeCtx(), storage, config, sub, 'recurrent', DUE)
    expect(sent).toHaveLength(0)
  })

  test('a mail-service failure is swallowed, never thrown at the scheduler', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const ctx = makeCtx()
    await expect(notifyUpcoming(ctx, makeStorage(), config, sub, 'recurrent', DUE)).resolves.toBeUndefined()
    expect(ctx.error).toHaveBeenCalled()
  })
})
