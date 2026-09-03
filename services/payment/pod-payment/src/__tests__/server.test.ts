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

// Drives createServer's express app directly, invoking the terminal route handler on a synthetic
// req/res. Only account-client's getClient and the provider factory are mocked.

import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { getClient, SubscriptionStatus, SubscriptionType } from '@hcengineering/account-client'
import { systemAccountUuid } from '@hcengineering/core'
import { PaymentProviderFactory } from '../factory'
import type { Config } from '../config'

jest.mock('@hcengineering/account-client', () => {
  const actual = jest.requireActual('@hcengineering/account-client')
  return { ...actual, getClient: jest.fn() }
})

jest.mock('../factory', () => ({
  PaymentProviderFactory: { getInstance: jest.fn() }
}))

jest.mock('../reconciliation', () => ({
  startActiveSubscriptionReconciliation: jest.fn(() => () => {})
}))

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}))

// server.ts imports the default config singleton for its module-level rate limiters, which throws
// at import time if required env vars are missing — set them before requiring server.ts.
process.env.SECRET = 'test-secret'
process.env.ACCOUNTS_URL = 'https://accounts.example.test'
process.env.FRONT_URL = 'https://front.example.test'
process.env.PROVIDER = 'stripe'
process.env.PLAN_CONFIG = '/fake/plan-config.yaml'

// config.ts validates the plan config at import time (every plan needs an explicit windowMonthLimit),
// and fs is mocked above — feed it a valid file before requiring the module.
const fsMock = jest.requireMock('fs')
fsMock.existsSync.mockReturnValue(true)
fsMock.readFileSync.mockReturnValue('plans:\n  business:\n    windowMonthLimit: 1000\n')

// Required after the env above: server.ts builds its rate limiters from the config singleton at
// import time, and that throws when the vars are missing.
/* eslint-disable @typescript-eslint/no-var-requires */
const { createServer } = require('../server') as typeof import('../server')
/* eslint-enable @typescript-eslint/no-var-requires */

const PLAN_CONFIG_YAML = `
plans:
  business:
    priceMonthlyPerUser: 500
    windowMonthLimit: 1000
    maxSeats: 50
  flatplan:
    priceMonthly: 2000
    windowMonthLimit: 800
    usersLimit: 10
packages:
  storage_small:
    category: storage
    priceMonthly: 500
    tokenLimit: 100
  storage_big:
    category: storage
    priceMonthly: 1000
    tokenLimit: 200
purchasables:
  credits_100:
    effect: grant_credits
    tokenLimit: 100
    category: tokens
`

const config: Config = {
  Port: 4040,
  Secret: 'secret',
  AccountsUrl: 'https://accounts.example.test',
  FrontUrl: 'https://front.example.test',
  Provider: 'stripe',
  PlanConfig: '/fake/plan-config.yaml',
  StripeApiKey: 'sk_test',
  StripeWebhookSecret: 'whsec',
  StripeSubscriptionPlans: '{}'
} as unknown as Config

// Route handlers run through ctx.with(...) (real MeasureContext); stub it as a passthrough so
// handleRequest actually awaits the handler instead of throwing on a missing method.
function makeCtx (): any {
  const ctx: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    logger: {},
    newChild: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
  }
  ctx.with = jest.fn((_name: string, _params: any, op: (c: any) => any) => Promise.resolve(op(ctx)))
  return ctx
}

function makeAccountClient (): any {
  return {
    getPurchases: jest.fn().mockResolvedValue([]),
    createPurchase: jest.fn().mockResolvedValue('new-purchase-id'),
    upsertSubscription: jest.fn().mockResolvedValue(undefined),
    getSubscriptions: jest.fn().mockResolvedValue([]),
    getSubscriptionById: jest.fn(),
    getSubscriptionByProviderId: jest.fn().mockResolvedValue(null),
    getWorkspaceInfo: jest.fn().mockResolvedValue({ usageInfo: { usage: { membersCount: 1 } } }),
    getWorkspaceMembers: jest.fn().mockResolvedValue([]),
    getLoginInfoByToken: jest.fn()
  }
}

function makeProvider (): any {
  return {
    providerName: 'stripe',
    registerWebhookEndpoints: jest.fn(),
    createSubscription: jest.fn(),
    getSubscription: jest.fn(),
    getSubscriptionByCheckout: jest.fn(),
    cancelSubscription: jest.fn(),
    uncancelSubscription: jest.fn(),
    updateSubscriptionPlan: jest.fn(),
    retryPayment: jest.fn(),
    reconcileActiveSubscriptions: jest.fn()
  }
}

// Pull the terminal (last) handler for a route, bypassing all auth/rate-limit middleware in front of it.
function getHandler (app: any, method: 'get' | 'post', path: string): (req: any, res: any) => void {
  const layer = app._router.stack.find((l: any) => l.route?.path === path && l.route?.methods[method] === true)
  if (layer === undefined) throw new Error(`route not found: ${method.toUpperCase()} ${path}`)
  const stack = layer.route.stack
  return stack[stack.length - 1].handle
}

// Fire-and-forget handlers signal completion via res.json/res.end; wait for that instead of the call itself.
function makeRes (): { res: any, done: Promise<any> } {
  let resolve: (v: any) => void = () => {}
  const done = new Promise<any>((_resolve) => {
    resolve = _resolve
  })
  const res: any = { statusCode: 200 }
  res.status = (c: number) => {
    res.statusCode = c
    return res
  }
  res.json = (b: any) => {
    res.body = b
    resolve(res)
    return res
  }
  res.end = () => {
    resolve(res)
    return res
  }
  res.set = () => res
  return { res, done }
}

let accountClient: ReturnType<typeof makeAccountClient>
let provider: ReturnType<typeof makeProvider>
let publish: jest.Mock
let logOperation: jest.Mock
let publishPurchaseActivated: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  ;(existsSync as jest.Mock).mockReturnValue(true)
  ;(readFileSync as jest.Mock).mockReturnValue(PLAN_CONFIG_YAML)
  accountClient = makeAccountClient()
  ;(getClient as jest.Mock).mockReturnValue(accountClient)
  provider = makeProvider()
  ;(PaymentProviderFactory.getInstance as jest.Mock).mockReturnValue({ create: jest.fn().mockReturnValue(provider) })
  publish = jest.fn().mockResolvedValue(undefined)
  logOperation = jest.fn().mockResolvedValue(undefined)
  publishPurchaseActivated = jest.fn().mockResolvedValue(undefined)
})

async function buildApp (): Promise<any> {
  const built = await createServer(makeCtx(), config, publish, logOperation, publishPurchaseActivated)
  return built
}

describe('checkout-status -> activatePurchase (dedup by paymentId+provider)', () => {
  const wsId = 'ws-1' as any
  const purchaseSub: any = {
    id: 'sub-x',
    workspaceUuid: wsId,
    accountUuid: 'acc-1',
    provider: 'stripe',
    providerSubscriptionId: 'pay_123',
    type: SubscriptionType.Purchase,
    plan: 'credits_100',
    amount: 999,
    status: SubscriptionStatus.Active,
    providerData: {}
  }

  function req (): any {
    return {
      params: { checkoutId: 'chk_1' },
      token: { account: systemAccountUuid, workspace: wsId },
      headers: {}
    }
  }

  it('first activation (no dedup hit): creates the purchase and publishes with the new id', async () => {
    const { app } = await buildApp()
    provider.getSubscriptionByCheckout.mockResolvedValue(purchaseSub)
    accountClient.getPurchases.mockResolvedValue([])
    accountClient.createPurchase.mockResolvedValue('purch-new')

    const handler = getHandler(app, 'get', '/api/v1/checkouts/:checkoutId/status')
    const { res, done } = makeRes()
    handler(req(), res)
    await done

    expect(accountClient.createPurchase).toHaveBeenCalledTimes(1)
    expect(accountClient.createPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceUuid: wsId, sku: 'credits_100', paymentId: 'pay_123', provider: 'stripe' })
    )
    expect(publishPurchaseActivated).toHaveBeenCalledTimes(1)
    expect(publishPurchaseActivated).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      'credits_100',
      'purch-new',
      'grant_credits', // effect from the purchasables catalog
      100 // tokenLimit from the purchasables catalog
    )
  })

  it('dedup hit, not consumed: republishes with the EXISTING purchase id, does not create a duplicate', async () => {
    const { app } = await buildApp()
    provider.getSubscriptionByCheckout.mockResolvedValue(purchaseSub)
    accountClient.getPurchases.mockResolvedValue([
      { id: 'purch-1', paymentId: 'pay_123', provider: 'stripe', status: 'active' }
    ])

    const handler = getHandler(app, 'get', '/api/v1/checkouts/:checkoutId/status')
    const { res, done } = makeRes()
    handler(req(), res)
    await done

    expect(accountClient.createPurchase).not.toHaveBeenCalled()
    expect(publishPurchaseActivated).toHaveBeenCalledTimes(1)
    expect(publishPurchaseActivated).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      'credits_100',
      'purch-1',
      'grant_credits',
      100
    )
  })

  it('dedup hit, already consumed: no republish, no create (regression guard)', async () => {
    const { app } = await buildApp()
    provider.getSubscriptionByCheckout.mockResolvedValue(purchaseSub)
    accountClient.getPurchases.mockResolvedValue([
      { id: 'purch-1', paymentId: 'pay_123', provider: 'stripe', status: 'consumed' }
    ])

    const handler = getHandler(app, 'get', '/api/v1/checkouts/:checkoutId/status')
    const { res, done } = makeRes()
    handler(req(), res)
    await done

    expect(accountClient.createPurchase).not.toHaveBeenCalled()
    expect(publishPurchaseActivated).not.toHaveBeenCalled()
  })

  // The checkout draft hits the queue when the payment link opens - it must not grant anything.
  it.each([
    ['pending draft', { status: SubscriptionStatus.PastDue, providerData: { pending: true } }],
    ['rejected payment', { status: SubscriptionStatus.PastDue, providerData: { pending: false } }],
    ['abandoned checkout', { status: SubscriptionStatus.Canceled, providerData: { pending: false } }]
  ])('%s: never activates the purchase', async (_name, patch) => {
    const { persistSubscription } = await buildApp()

    await persistSubscription({ ...purchaseSub, ...patch })

    expect(accountClient.createPurchase).not.toHaveBeenCalled()
    expect(publishPurchaseActivated).not.toHaveBeenCalled()
  })
})

describe('subscribe: same-category package replacement aborts on cancelSubscription failure', () => {
  const wsId = 'ws-2' as any

  function req (body: any): any {
    return {
      params: { workspace: wsId },
      body,
      token: { account: 'acc-1' as any, workspace: wsId },
      loginInfo: { workspaceUrl: 'ws2.example.test' },
      headers: {}
    }
  }

  const oldPkg: any = {
    id: 'sub-old',
    type: SubscriptionType.Package,
    status: SubscriptionStatus.Active,
    plan: 'storage_small',
    provider: 'stripe',
    providerSubscriptionId: 'psub-old',
    workspaceUuid: wsId
  }

  it('cancel fails -> 500 to the client, new package is NEVER created (no double billing)', async () => {
    const { app } = await buildApp()
    accountClient.getSubscriptions.mockResolvedValue([oldPkg])
    provider.cancelSubscription.mockRejectedValue(new Error('provider unreachable'))

    const handler = getHandler(app, 'post', '/api/v1/subscriptions/:workspace/subscribe')
    const { res, done } = makeRes()
    handler(req({ type: SubscriptionType.Package, plan: 'storage_big' }), res)
    await done

    expect(res.statusCode).toBe(500)
    expect(provider.createSubscription).not.toHaveBeenCalled()
  })

  it('cancel succeeds -> old package canceled, new package created (contrast/happy path)', async () => {
    const { app } = await buildApp()
    accountClient.getSubscriptions.mockResolvedValue([oldPkg])
    provider.cancelSubscription.mockResolvedValue({ ...oldPkg, status: SubscriptionStatus.Canceled })
    provider.createSubscription.mockResolvedValue({ checkoutId: 'chk_2', checkoutUrl: 'https://pay/2' })

    const handler = getHandler(app, 'post', '/api/v1/subscriptions/:workspace/subscribe')
    const { res, done } = makeRes()
    handler(req({ type: SubscriptionType.Package, plan: 'storage_big' }), res)
    await done

    expect(res.statusCode).toBe(200)
    expect(provider.createSubscription).toHaveBeenCalledTimes(1)
  })
})

describe('updatePlan -> resolveLimits (via attachLimits on the persisted response)', () => {
  // Real UUID: resolveSeatQuantity (per-seat branch) calls generateToken(sys, workspace, ...), which
  // validates the workspace as a UUID before the account-client mock ever sees it.
  const wsId = randomUUID() as any

  function req (id: string, body: any): any {
    return {
      params: { subscriptionId: id },
      body,
      token: { account: 'acc-1' as any, workspace: wsId },
      loginInfo: { workspaceUrl: 'ws3.example.test' },
      headers: {}
    }
  }

  it('per-seat tier plan: windowMonthLimit and usersLimit scale with quantity', async () => {
    const { app } = await buildApp()
    const existing: any = {
      id: 'sub-tier',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: 'business',
      provider: 'stripe',
      providerSubscriptionId: 'psub-tier',
      workspaceUuid: wsId,
      accountUuid: 'acc-1',
      providerData: { quantity: 3 }
    }
    accountClient.getSubscriptionById.mockResolvedValue(existing)
    provider.updateSubscriptionPlan.mockResolvedValue({ ...existing, providerData: { quantity: 6 }, amount: 3000 })

    const handler = getHandler(app, 'post', '/api/v1/subscriptions/:subscriptionId/updatePlan')
    const { res, done } = makeRes()
    handler(req('sub-tier', { plan: 'business', quantity: 6, period: 'monthly' }), res)
    await done

    expect(res.statusCode).toBe(200)
    expect(res.body.limits.usersLimit).toBe(6)
    expect(res.body.limits.windowMonthLimit).toBe(6000) // 1000 * 6
  })

  it('flat package: limits do not scale with seats (quantity forced undefined for non-per-seat items)', async () => {
    const { app } = await buildApp()
    const existing: any = {
      id: 'sub-pkg',
      type: SubscriptionType.Package,
      status: SubscriptionStatus.Active,
      plan: 'storage_small',
      provider: 'stripe',
      providerSubscriptionId: 'psub-pkg',
      workspaceUuid: wsId,
      accountUuid: 'acc-1',
      providerData: {}
    }
    accountClient.getSubscriptionById.mockResolvedValue(existing)
    accountClient.getSubscriptions.mockResolvedValue([])
    provider.updateSubscriptionPlan.mockResolvedValue({
      ...existing,
      plan: 'storage_big',
      providerData: {},
      amount: 1000
    })

    const handler = getHandler(app, 'post', '/api/v1/subscriptions/:subscriptionId/updatePlan')
    const { res, done } = makeRes()
    // quantity in the request body must be ignored for a flat package.
    handler(req('sub-pkg', { plan: 'storage_big', quantity: 99 }), res)
    await done

    expect(res.statusCode).toBe(200)
    expect(res.body.limits.tokenLimit).toBe(200)
    expect(res.body.limits.usersLimit).toBe(0)
  })
})

// A plan missing windowMonthLimit no longer warns here — config.ts refuses to start the pod at all.
// See config.test.ts.
