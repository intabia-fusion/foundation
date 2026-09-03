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

import { notifyPaymentSucceeded, notifyPaymentFailed } from '../notifications'

// Guards the 'purchase' key in SERVICE.type (templates/service.ts), added for FUSIO-866.

const config: any = {
  MailUrl: 'http://mail:8097',
  MailFrom: 'platform@intabia.ru',
  FrontUrl: 'https://app.intabia.ru',
  PaymentUrl: undefined, // no plan-config lookup: getPlanLabel falls back to the raw plan id
  BillingEmails: ['billing@intabia.ru']
}

function makeStorage (): any {
  return {
    getAccountContact: jest.fn().mockResolvedValue({ name: 'Иван', email: 'payer@x.com', phone: null, locale: 'ru' }),
    getWorkspaceUrl: jest.fn().mockResolvedValue('my-company')
  }
}

function makeCtx (): any {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

// Capture messages posted to pod-mail; `to` identifies payer vs. billing-team copy.
let sent: any[] = []

beforeEach(() => {
  sent = []
  global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }) as any
})

const purchaseSub: any = {
  id: 'tbank_p1',
  provider: 'tbank',
  providerSubscriptionId: 'p1',
  workspaceUuid: 'ws-1',
  accountUuid: 'acc-1',
  type: 'purchase',
  plan: 'credits_100',
  status: 'active',
  amount: 9900,
  periodStart: Date.now(),
  providerData: {}
}

describe('billing service-copy email: SubscriptionType label', () => {
  it('purchase subscription -> "разовая покупка" in the service copy, not the raw "purchase" string', async () => {
    await notifyPaymentSucceeded(makeCtx(), makeStorage(), config, purchaseSub, 'purchase')

    const svc = sent.find((m) => m.to === 'billing@intabia.ru')
    expect(svc).toBeDefined()
    expect(svc.text).toContain('(разовая покупка)')
    expect(svc.text).not.toContain('(purchase)')
  })

  it('failed-payment service copy also localizes a purchase subscription type', async () => {
    const failedPurchase = { ...purchaseSub, status: 'past_due', providerData: { retryAttempt: 1 } }
    await notifyPaymentFailed(makeCtx(), makeStorage(), config, failedPurchase, 'failed')

    const svc = sent.find((m) => m.to === 'billing@intabia.ru')
    expect(svc).toBeDefined()
    expect(svc.text).toContain('(разовая покупка)')
    expect(svc.text).not.toContain('(purchase)')
  })

  it('tier subscription still renders its own label (no cross-regression)', async () => {
    const tierSub = { ...purchaseSub, type: 'tier', plan: 'business' }
    await notifyPaymentSucceeded(makeCtx(), makeStorage(), config, tierSub, 'purchase')

    const svc = sent.find((m) => m.to === 'billing@intabia.ru')
    expect(svc.text).toContain('(тариф)')
  })
})
