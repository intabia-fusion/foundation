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

import { SubscriptionStatus, SubscriptionType } from '@hcengineering/account-client'
import { SubscriptionStorage } from '../storage'

const NOW = Date.UTC(2026, 6, 19)

const baseSub: any = {
  id: 'tbank_1',
  provider: 'tbank',
  providerSubscriptionId: '1',
  status: SubscriptionStatus.Active,
  periodEnd: NOW - 1000,
  providerData: { rebillId: 'reb_1' }
}

describe('SubscriptionStorage.needsRenewal', () => {
  test('no rebillId -> false (never charged, nothing to renew)', () => {
    const sub = { ...baseSub, providerData: {} }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('recurrent === false -> false (one-off purchase never auto-renews)', () => {
    // Even with a rebillId present and the period elapsed: the user did not consent to autopay.
    const sub = { ...baseSub, providerData: { rebillId: 'reb_1', recurrent: false } }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('recurrent === true -> renews as usual', () => {
    const sub = { ...baseSub, providerData: { rebillId: 'reb_1', recurrent: true } }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(true)
  })

  test('scheduled cancel already reached (periodEnd >= willCancelAt) -> false', () => {
    const sub = { ...baseSub, willCancelAt: NOW - 2000 } // periodEnd (NOW-1000) >= willCancelAt
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('Active + periodEnd in the past -> true', () => {
    expect(SubscriptionStorage.needsRenewal(baseSub, NOW)).toBe(true)
  })

  test('Active + periodEnd in the future -> false', () => {
    const sub = { ...baseSub, periodEnd: NOW + 1000 }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('Active + willCancelAt not yet reached -> true (scheduled cancel does not block early renewal)', () => {
    const sub = { ...baseSub, willCancelAt: NOW + 1000 }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(true)
  })

  test('failed renewal, retryAttempt >= 3 -> false (retries exhausted)', () => {
    const sub = {
      ...baseSub,
      status: SubscriptionStatus.PastDue,
      providerData: { rebillId: 'reb_1', pending: false, retryAttempt: 3 }
    }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('failed renewal, retryAfter in the future -> false (back-off not elapsed)', () => {
    const sub = {
      ...baseSub,
      status: SubscriptionStatus.PastDue,
      providerData: { rebillId: 'reb_1', pending: false, retryAttempt: 1, retryAfter: NOW + 1000 }
    }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('failed renewal, retryAfter elapsed and attempts left -> true', () => {
    const sub = {
      ...baseSub,
      status: SubscriptionStatus.PastDue,
      providerData: { rebillId: 'reb_1', pending: false, retryAttempt: 1, retryAfter: NOW - 1000 }
    }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(true)
  })

  test('pending first-payment draft (PastDue + pending:true) -> false, not a failed renewal', () => {
    const sub = {
      ...baseSub,
      status: SubscriptionStatus.PastDue,
      providerData: { rebillId: 'reb_1', pending: true }
    }
    expect(SubscriptionStorage.needsRenewal(sub, NOW)).toBe(false)
  })

  test('other statuses (Canceled, ReadOnly) -> false', () => {
    expect(SubscriptionStorage.needsRenewal({ ...baseSub, status: SubscriptionStatus.Canceled }, NOW)).toBe(false)
    expect(SubscriptionStorage.needsRenewal({ ...baseSub, status: SubscriptionStatus.ReadOnly }, NOW)).toBe(false)
  })
})

describe('SubscriptionStorage.claimCheckout slot', () => {
  const workspace = 'ws-1' as any

  function storageWith (): { storage: SubscriptionStorage, claimIntent: jest.Mock } {
    const claimIntent = jest.fn().mockResolvedValue({ claimed: true, intent: { id: 'i1', status: 'pending' } })
    return { storage: new SubscriptionStorage({ claimIntent } as any, async () => {}), claimIntent }
  }

  test('tier keeps one slot per type: a different order collides with the pending checkout', async () => {
    const { storage, claimIntent } = storageWith()
    await storage.claimCheckout(workspace, SubscriptionType.Tier, 'pro:5:monthly')
    await storage.claimCheckout(workspace, SubscriptionType.Tier, 'pro:9:monthly')
    expect(claimIntent.mock.calls[0][0]).toBe('checkout:ws-1:tier')
    expect(claimIntent.mock.calls[1][0]).toBe(claimIntent.mock.calls[0][0])
  })

  test('purchases claim per order: an abandoned SKU does not block buying another', async () => {
    const { storage, claimIntent } = storageWith()
    await storage.claimCheckout(workspace, SubscriptionType.Purchase, 'tokens-1m:1:undefined')
    await storage.claimCheckout(workspace, SubscriptionType.Purchase, 'tokens-5m:1:undefined')
    expect(claimIntent.mock.calls[0][0]).toBe('checkout:ws-1:purchase:tokens-1m:1:undefined')
    expect(claimIntent.mock.calls[1][0]).toBe('checkout:ws-1:purchase:tokens-5m:1:undefined')
  })

  test('repeat click on the same purchase still shares a slot (URL reuse, no duplicate charge)', async () => {
    const { storage, claimIntent } = storageWith()
    await storage.claimCheckout(workspace, SubscriptionType.Purchase, 'tokens-1m:1:undefined')
    await storage.claimCheckout(workspace, SubscriptionType.Purchase, 'tokens-1m:1:undefined')
    expect(claimIntent.mock.calls[1][0]).toBe(claimIntent.mock.calls[0][0])
  })
})
