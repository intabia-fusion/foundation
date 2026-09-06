//
// Copyright © 2025 Hardcore Engineering Inc.
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

import cors from 'cors'
import express, { type Express, NextFunction, type Request, type Response } from 'express'
import { type Server } from 'http'
import {
  AccountRole,
  generateId,
  MeasureContext,
  systemAccountUuid,
  type WorkspaceUuid,
  type AccountUuid
} from '@hcengineering/core'
import morgan from 'morgan'
import onHeaders from 'on-headers'
import rateLimit from 'express-rate-limit'
import { generateToken } from '@hcengineering/server-token'
import {
  SubscriptionData,
  SubscriptionUpsert,
  SubscriptionStatus,
  SubscriptionType,
  type WorkspaceLoginInfo,
  prorateSeats,
  proratePackage
} from '@hcengineering/account-client'

import appConfig, { Config } from './config'
import { ownsSubscription, withAdmin, withLoginInfo, withOwner, withToken, type RequestWithAuth } from './middleware'
import { PaymentProviderFactory } from './factory'
import type { BillingPeriod, CheckoutResponse, PaymentProvider, SubscriptionPublisher } from './providers'
import { ProviderHttpError, SubscribeRequest } from './providers'
import { startActiveSubscriptionReconciliation } from './reconciliation'
import { startTrialExpiry } from './trialExpiry'
import { backfillWindowLimits } from './windowBackfill'
import { getAccountClient, hasGrantingTier, computePlanPrice, validateSeatQuantity, MAX_SEATS_FALLBACK } from './utils'
import * as yaml from 'js-yaml'
import { existsSync, readFileSync } from 'fs'

const KEEP_ALIVE_TIMEOUT = 5 // seconds

// Mutating subscription ops are rare per user; keep tight.
const subscriptionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: appConfig.SubscriptionRateLimitMax ?? 30,
  message: 'Too many subscription requests, please try again later',
  standardHeaders: true
})

// Checkout-status is polled ~every 2s while paying; softer ceiling than mutating ops.
const pollRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many status requests, please try again later',
  standardHeaders: true
})

// Plan-config is a static read hit twice per billing page open. Behind NAT (docker, CI) the whole
// suite shares one IP and starves the shared poll ceiling, so it gets its own knob to lift.
const planConfigRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: appConfig.PlanConfigRateLimitMax ?? 200,
  message: 'Too many plan-config requests, please try again later',
  standardHeaders: true
})

type AsyncRequestHandler = (ctx: MeasureContext, req: Request, res: Response) => Promise<void>

function relayProviderError (res: Response, err: unknown, fallbackMsg: string): void {
  if (err instanceof ProviderHttpError) {
    // Prefer the provider's own error text (e.g. a declined-card message) over the generic fallback,
    // so the user sees why the payment failed rather than "Failed to update subscription at provider".
    let providerMsg: string | undefined
    if (err.body !== undefined) {
      try {
        providerMsg = JSON.parse(err.body).error
      } catch {
        /* body isn't JSON — keep the fallback */
      }
    }
    res.status(err.status).json({ reason: err.reason, error: providerMsg ?? fallbackMsg })
    return
  }
  res.status(500).json({ error: fallbackMsg })
}

// 503 guard for endpoints that require a configured payment provider. Returns true if the
// response was written (caller must return immediately).
function requireProvider (provider: PaymentProvider | undefined, res: Response): boolean {
  if (provider === undefined) {
    res.status(503).json({ error: 'Payment provider is not configured' })
    return true
  }
  return false
}

const handleRequest = async (
  ctx: MeasureContext,
  name: string,
  fn: AsyncRequestHandler,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await ctx.with(name, {}, (ctx) => {
      onHeaders(res, () => {
        const measurements = ctx.metrics?.measurements
        if (measurements !== undefined) {
          const values = []
          for (const [k, v] of Object.entries(measurements)) {
            values.push(`${k};dur=${v.value.toFixed(2)}`)
          }
          if (values.length > 0) {
            if (!res.headersSent) {
              res.setHeader('Server-Timing', values.join(', '))
            }
          }
        }
      })
      return fn(ctx, req, res)
    })
  } catch (err: unknown) {
    ctx.error('Failed to process payment request', { err })
    res.status(500).end()
  }
}

export async function createServer (
  ctx: MeasureContext,
  config: Config,
  // Publishes provider subscription events to the queue (durable, provider-agnostic). Required.
  publish: SubscriptionPublisher,
  // Best-effort ledger audit for direct (non-queue) writes like free/trial provisioning.
  logOperation?: (ctx: MeasureContext, sub: SubscriptionData, canceled: boolean) => Promise<void>,
  // Announces a confirmed one-time purchase (generic) so the owning pod applies its SKU effect.
  publishPurchaseActivated?: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    sku: string,
    purchaseId: string,
    effect?: string,
    quantity?: number
  ) => Promise<void>
): Promise<{
    app: Express
    ensureInitialSubscription: (workspace: WorkspaceUuid) => Promise<void>
    createFreeIfNoActiveTier: (workspace: WorkspaceUuid, actionId?: string, canceledPlan?: string) => Promise<void>
    persistSubscription: (data: SubscriptionData) => Promise<void>
    close: () => void
  }> {
  const app = express()
  // Trust one proxy hop (traefik). `true` trusts whole XFF chain -> client spoofs IP, evades per-IP limiter.
  app.set('trust proxy', 1)
  app.use(cors())

  const childLogger = ctx.logger.childLogger?.('requests', { enableConsole: 'true' })
  const requests = ctx.newChild('requests', {}, { logger: childLogger, span: false })
  class LogStream {
    write (text: string): void {
      requests.info(text)
    }
  }

  app.use(morgan('short', { stream: new LogStream() }))

  // Apply JSON parsing conditionally - skip for webhook routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/webhooks/')) {
      // Webhooks need raw body for signature verification
      express.raw({ type: 'application/json' })(req, res, next)
    } else {
      // JSON parsing for all other routes
      express.json()(req, res, next)
    }
  })

  const serviceToken = generateToken(systemAccountUuid, undefined, { service: 'payment' })
  const accountClient = getAccountClient(config.AccountsUrl, serviceToken)

  let provider: PaymentProvider | undefined

  switch (config.Provider) {
    case 'mock':
      // Mock activates any plan without payment — require an explicit opt-in so it cannot
      // reach production through a misconfigured PROVIDER env.
      if (config.AllowMockProvider !== true) {
        throw new Error('PROVIDER=mock requires ALLOW_MOCK_PROVIDER=true (mock activates plans without payment)')
      }
      // created after planConfig loads — see below
      break
    case 'polar':
      provider = PaymentProviderFactory.getInstance().create(
        'polar',
        {
          accessToken: config.PolarAccessToken,
          webhookSecret: config.PolarWebhookSecret,
          subscriptionPlans: config.PolarSubscriptionPlans,
          frontUrl: config.FrontUrl
        },
        accountClient,
        config.UseSandbox
      )
      break
    case 'stripe':
      provider = PaymentProviderFactory.getInstance().create(
        'stripe',
        {
          apiKey: config.StripeApiKey,
          webhookSecret: config.StripeWebhookSecret,
          subscriptionPlans: config.StripeSubscriptionPlans,
          frontUrl: config.FrontUrl
        },
        accountClient,
        false
      )
      break
    case 'tbank':
      provider = PaymentProviderFactory.getInstance().create(
        'tbank',
        {
          tbankSubscriptionsUrl: config.TbankSubscriptionsUrl
        },
        accountClient,
        false
      )
      break
    default:
      throw new Error(`Unknown payment provider: ${config.Provider}. Expected one of: mock, polar, stripe, tbank`)
  }

  // Plan config — loaded from PLAN_CONFIG env (YAML file path), falls back to empty config
  const planConfig: any = (() => {
    try {
      const configPath = config.PlanConfig
      if (configPath === undefined || configPath.length === 0) return { plans: {}, packages: {}, purchasables: {} }
      if (!existsSync(configPath)) {
        ctx.error('Plan config file not found', { path: configPath })
        return { plans: {}, packages: {}, purchasables: {} }
      }
      const content = readFileSync(configPath, 'utf-8')
      // windowMonthLimit is required on every plan — config.ts refuses to start the pod without it.
      return yaml.load(content) as any
    } catch (err: any) {
      ctx.error('Failed to load plan config', { err })
      return { plans: {}, packages: {}, purchasables: {} }
    }
  })()

  app.get('/api/v1/plan-config', planConfigRateLimiter, (req, res) => {
    res.json(planConfig)
  })

  function resolveLimits (type: SubscriptionType, plan: string, quantity?: number): SubscriptionData['limits'] {
    // Purchases grant no limit snapshot — their effect runs on activation, not as baked limits.
    if (type === SubscriptionType.Purchase) return undefined
    const source = type === SubscriptionType.Package ? planConfig.packages : planConfig.plans
    const item = source?.[plan]
    if (item == null) return undefined
    const isPerSeat = item.priceMonthlyPerUser != null
    const usersLimit = isPerSeat && quantity != null ? quantity : (item.usersLimit ?? 0)
    // storagePerUserGB (e.g. free tier) -> disk scales with the seat budget; else fixed storageLimitGB.
    const storageLimitGB =
      item.storagePerUserGB != null ? usersLimit * item.storagePerUserGB : (item.storageLimitGB ?? 0)
    // AI window: per-seat plans scale the token window by paid seats; flat plans (free) keep it fixed.
    const baseWindow = item.windowMonthLimit ?? 0
    const windowMonthLimit = isPerSeat && quantity != null ? baseWindow * quantity : baseWindow
    return {
      storageLimitGB,
      trafficLimitGB: item.trafficLimitGB ?? 0,
      meetingMinutesLimit: item.meetingMinutesLimit ?? 0,
      tokenLimit: item.tokenLimit ?? 0,
      usersLimit,
      windowMonthLimit
    }
  }

  // Token budget of a plan, for the downgrade gate: tier -> monthly window, package -> package quota.
  function planTokenBudget (type: SubscriptionType, plan: string): number {
    const item = (type === SubscriptionType.Package ? planConfig.packages : planConfig.plans)?.[plan]
    if (item == null) return 0
    return type === SubscriptionType.Package ? (item.tokenLimit ?? 0) : (item.windowMonthLimit ?? 0)
  }

  // Full price (kopecks) for a plan at the given seats/period (see computePlanPrice).
  function planFullPrice (type: SubscriptionType, plan: string, quantity: number, period?: BillingPeriod): number {
    const source =
      type === SubscriptionType.Package
        ? planConfig.packages
        : type === SubscriptionType.Purchase
          ? planConfig.purchasables
          : planConfig.plans
    return computePlanPrice(source?.[plan], quantity, period === 'yearly')
  }

  // Free fallback plan (flagged free:true in config) — its name, used to auto-provision a free tier.
  // Free fallback LIMITS are no longer baked here: the account server fills them from FREE_PLAN_LIMITS.
  const freePlanName: string | undefined = Object.entries(planConfig.plans ?? {}).find(
    ([, p]: [string, any]) => p?.free === true
  )?.[0]

  // Optional trial for new workspaces (plan-config.yaml `trial:`). When absent/malformed, new
  // workspaces get free. Validate numbers so a bad yaml can't yield NaN trialEnd (a dead trial).
  const trialConfig: { plan: string, days: number, usersLimit: number, windowMonthLimit?: number } | undefined =
    (() => {
      const t = planConfig.trial
      if (t?.plan == null || planConfig.plans?.[t.plan] == null) return undefined
      if (!Number.isFinite(t.days) || t.days <= 0 || !Number.isFinite(t.usersLimit) || t.usersLimit < 0) {
        ctx.error('invalid trial config, ignoring', { trial: t })
        return undefined
      }
      // Flat AI grant for the whole trial. Without it the trial inherits the plan's per-seat window
      // multiplied by the trial seat cap, which is far more AI than a trial should hand out.
      const window = Number.isFinite(t.windowMonthLimit) && t.windowMonthLimit >= 0 ? t.windowMonthLimit : undefined
      return { plan: t.plan, days: t.days, usersLimit: t.usersLimit, windowMonthLimit: window }
    })()

  function attachLimits (data: SubscriptionData): SubscriptionData {
    const quantity = data.providerData?.quantity as number | undefined
    const limits = resolveLimits(data.type, data.plan, quantity)
    if (limits === undefined) return data
    return { ...data, limits }
  }

  // The single chokepoint that writes a subscription to the account DB. Bakes paid limits, then upserts.
  // Both sync (HTTP user actions) and async (provider events via the Subscription queue) funnel through
  // here so limits are always baked consistently regardless of provider. Idempotent (account dedups by
  // provider + providerSubscriptionId), so queue replays are safe.
  // A confirmed one-time purchase: record it, then announce PurchaseActivated so the owning
  // pod (e.g. aibot) applies the SKU effect. Never touches the subscription table.
  async function activatePurchase (data: SubscriptionData): Promise<void> {
    // Dedup here by provider payment id: purchases never hit the subscription table,
    // so the caller-side dedup does not cover the queue/poll redelivery of this call.
    const existing = await accountClient.getPurchases(data.workspaceUuid)
    const item = planConfig.purchasables?.[data.plan]
    const dup = existing.find((p) => p.paymentId === data.providerSubscriptionId && p.provider === data.provider)
    if (dup !== undefined) {
      // Pod may have died between createPurchase and the publish below — republish until the
      // consumer marks it consumed. Consumer (ai-bot) dedups by purchaseId, so a redundant publish is safe.
      // Only an active one: a 'failed' or 'pending' purchase has no effect to apply.
      if (dup.status === 'active' && dup.id !== undefined) {
        await publishPurchaseActivated?.(ctx, data.workspaceUuid, data.plan, dup.id, item?.effect, item?.tokenLimit)
      }
      return
    }
    const category: string | undefined = item?.category
    const id = await accountClient.createPurchase({
      workspaceUuid: data.workspaceUuid,
      accountUuid: data.accountUuid,
      sku: data.plan,
      category,
      status: 'active',
      amount: data.amount,
      paymentId: data.providerSubscriptionId,
      provider: data.provider,
      raw: { providerData: data.providerData }
    })
    await publishPurchaseActivated?.(ctx, data.workspaceUuid, data.plan, id, item?.effect, item?.tokenLimit)
  }

  async function persistSubscription (data: SubscriptionData): Promise<void> {
    if (data.type === SubscriptionType.Purchase) {
      // Store the checkout record too: the provider pod looks the draft up by paymentId on webhook.
      await accountClient.upsertSubscription(data)
      // Only a settled payment grants the SKU effect - the draft is queued when the link opens.
      if (data.providerData?.pending === true || data.status !== SubscriptionStatus.Active) return
      await activatePurchase(data)
      return
    }
    await accountClient.upsertSubscription(attachLimits(data))
  }

  // Provider events go through the queue (durable: a webhook is ack'd to the provider even if the
  // account DB is momentarily down; the consumer persists later).
  const publishSubscription: SubscriptionPublisher = publish

  // On workspace creation: if no tier subscription exists and a free plan is configured, create one
  // so the workspace is bounded by free limits from the start. Idempotent (skips if a tier exists).
  // Provision the initial tier for a new workspace: a trial when configured, else the free plan.
  async function ensureInitialSubscription (workspace: WorkspaceUuid): Promise<void> {
    try {
      const existing = await accountClient.getSubscriptions(workspace, false)
      if (existing.some((s) => s.type === SubscriptionType.Tier)) return // already has a tier
      // Trial is best-effort: no trial configured, or it could not be built -> fall back to free.
      if (trialConfig !== undefined && (await createTrialSubscription(workspace)) !== undefined) return
      await createFreeSubscription(workspace)
    } catch (err: any) {
      ctx.error('failed to ensure initial subscription', { workspace, err })
    }
  }

  // Create a Trialing subscription on the configured trial plan for a new workspace.
  async function createTrialSubscription (
    workspace: WorkspaceUuid,
    accountUuid?: AccountUuid
  ): Promise<SubscriptionData | undefined> {
    if (trialConfig === undefined) return
    const wsToken = generateToken(systemAccountUuid, workspace, { service: 'payment' })
    const members = await getAccountClient(config.AccountsUrl, wsToken).getWorkspaceMembers()
    const owner = members.find((m) => m.role === AccountRole.Owner) ?? members[0]
    if (owner === undefined) return
    const subId = generateId()
    // Trial seats: at least current members + 5 so existing users keep working on trial start.
    const usersLimit = Math.max(trialConfig.usersLimit, members.length + 5)
    // Plan limits (storage/tokens/etc), then force usersLimit to the trial cap so the seat count is
    // independent of the plan's per-seat/flat shape. resolveLimits fully-populates or returns undefined.
    const planLimits = resolveLimits(SubscriptionType.Tier, trialConfig.plan, usersLimit)
    const limits = { ...planLimits, usersLimit }
    // Flat trial AI grant, not the plan's per-seat window times the seat cap.
    if (trialConfig.windowMonthLimit !== undefined) {
      limits.windowMonthLimit = trialConfig.windowMonthLimit
    }
    const data: SubscriptionData = {
      id: subId,
      workspaceUuid: workspace,
      accountUuid: accountUuid ?? owner.person,
      provider: 'trial',
      providerSubscriptionId: `trial-${subId}`,
      periodStart: Date.now(),
      periodEnd: undefined,
      trialEnd: Date.now() + trialConfig.days * 24 * 60 * 60 * 1000,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Trialing,
      plan: trialConfig.plan,
      limits,
      providerData: { quantity: usersLimit }
    } as unknown as SubscriptionData
    await accountClient.upsertSubscription(data)
    await logOperation?.(ctx, data, false)
    ctx.info('trial subscription created for workspace', { workspace, plan: trialConfig.plan, trialEnd: data.trialEnd })
    return data
  }

  // Create a free subscription after finalized user-initiated cancelation of a paid subscription
  // actionId of the cancel that dropped the paid tier — the free fallback belongs to that same action.
  // When canceling the free plan, we do not provision another free plan.
  async function createFreeIfNoActiveTier (
    workspace: WorkspaceUuid,
    actionId?: string,
    canceledPlan?: string
  ): Promise<void> {
    if (freePlanName === undefined) return
    if (canceledPlan !== undefined && planConfig.plans?.[canceledPlan]?.free === true) return
    try {
      const existing = await accountClient.getSubscriptions(workspace, false)
      if (hasGrantingTier(existing)) return
      await createFreeSubscription(workspace, undefined, actionId)
    } catch (err: any) {
      ctx.error('failed to create free subscription after cancel', { workspace, err })
    }
  }

  /**
   * Assemble a free-tier payload without writing it.
   * `accountUuid` may stay empty — account fills the workspace owner in under the NOT NULL FK.
   */
  function buildFreeSubscription (
    workspace: WorkspaceUuid,
    accountUuid?: AccountUuid,
    actionId?: string
  ): SubscriptionUpsert | undefined {
    if (freePlanName === undefined) return
    const subId = generateId()
    return attachLimits({
      id: subId,
      workspaceUuid: workspace,
      accountUuid,
      provider: 'free',
      providerSubscriptionId: `free-${subId}`,
      periodStart: Date.now(),
      periodEnd: undefined,
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: freePlanName,
      providerData: actionId !== undefined ? { actionId } : undefined
    } as unknown as SubscriptionData)
  }

  async function createFreeSubscription (
    workspace: WorkspaceUuid,
    accountUuid?: AccountUuid,
    actionId?: string
  ): Promise<SubscriptionUpsert | undefined> {
    const data = buildFreeSubscription(workspace, accountUuid, actionId)
    if (data === undefined) return
    await accountClient.upsertSubscription(data)
    await logOperation?.(ctx, data as SubscriptionData, false)
    ctx.info('free subscription created for workspace', { workspace, plan: freePlanName })
    return data
  }

  // Seat floor for a purchase = the current seat count already computed by pod-billing (same
  // seatEligible rule as usage/enforcement) and stored on the account. Read it from account instead
  // of re-counting via the transactor, so payment stays decoupled from the workspace. Lags the
  // pod-billing refresh (~25s); acceptable for a purchase floor.
  async function billableMembersCount (workspace: WorkspaceUuid): Promise<number> {
    const wsToken = generateToken(systemAccountUuid, workspace, { service: 'payment' })
    const account = getAccountClient(config.AccountsUrl, wsToken)
    const info = await account.getWorkspaceInfo(false)
    return info.usageInfo?.usage.membersCount ?? 0
  }

  // For per-seat plans, validate the requested seat count
  async function resolveSeatQuantity (
    plan: string,
    requested: number | undefined,
    workspace: WorkspaceUuid
  ): Promise<{ quantity?: number, error?: string }> {
    const item = planConfig.plans?.[plan]
    const isPerSeat = item?.priceMonthlyPerUser != null
    if (!isPerSeat) return { quantity: undefined }
    const min = Math.max(await billableMembersCount(workspace), 1)
    const rawMax = Number(item.maxSeats)
    const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : MAX_SEATS_FALLBACK
    return validateSeatQuantity(requested ?? min, min, max)
  }

  // Common preamble for :subscriptionId endpoints: look up by internal id, 404 if missing,
  // 403 if it doesn't belong to the caller's workspace. Writes the response and returns
  // undefined on failure.
  async function loadOwnedSubscription (req: RequestWithAuth, res: Response): Promise<SubscriptionData | undefined> {
    const subscriptionId = req.params.subscriptionId
    const subscription = await accountClient.getSubscriptionById(subscriptionId)
    if (subscription === undefined || subscription === null) {
      res.status(404).json({ error: 'Subscription not found' })
      return undefined
    }
    if (!ownsSubscription(req, subscription)) {
      res.status(403).json({ error: 'Subscription does not belong to this workspace' })
      return undefined
    }
    return subscription
  }

  // Shared cancel/uncancel logic: provider-mismatched subscriptions are mutated locally,
  // same-provider ones go through the provider call. `res` is written on all failure paths.
  async function runProviderOrLocal (
    ctx: MeasureContext,
    res: Response,
    subscription: SubscriptionData,
    opts: {
      localPatch: Partial<SubscriptionData>
      localLogMessage: string
      providerCall: (ctx: MeasureContext, providerSubId: string) => Promise<SubscriptionData | null>
      providerNotFoundMsg: string
      providerErrorMsg: string
    }
  ): Promise<SubscriptionData | undefined> {
    if (subscription.provider !== config.Provider) {
      const updated: SubscriptionData = { ...subscription, ...opts.localPatch }
      await persistSubscription(updated)
      ctx.info(opts.localLogMessage, { id: subscription.id, provider: subscription.provider })
      return updated
    }

    try {
      const result = await opts.providerCall(ctx, subscription.providerSubscriptionId)
      if (result === null) {
        res.status(404).json({ error: opts.providerNotFoundMsg })
        return undefined
      }
      await persistSubscription(result)
      return result
    } catch (err) {
      ctx.error(opts.providerErrorMsg, { err })
      res.status(500).json({ error: opts.providerErrorMsg })
      return undefined
    }
  }

  if (config.Provider === 'mock') {
    // Packages have prices too (priceMonthly); merge them so computeAmount finds package plans.
    provider = PaymentProviderFactory.getInstance().create(
      'mock',
      { frontUrl: config.FrontUrl, plans: { ...planConfig.plans, ...planConfig.packages, ...planConfig.purchasables } },
      accountClient
    )
  }

  if (provider !== undefined) {
    provider.registerWebhookEndpoints(app, ctx, config.AccountsUrl, serviceToken, publishSubscription)
    ctx.info(`${config.Provider} payment provider initialized successfully`)
  }

  if (provider == null) {
    throw new Error(`Failed to initialize payment provider: ${config.Provider}`)
  }

  // Packages are available on any tier, including free/no-plan: only require the package to exist.
  function isPackageEligible (pkgKey: string, _currentTierPlan: string | undefined): boolean {
    return planConfig?.packages?.[pkgKey] !== undefined
  }

  const stopReconciliation = startActiveSubscriptionReconciliation(
    ctx,
    config.AccountsUrl,
    serviceToken,
    provider,
    config.ReconciliationIntervalMinutes ?? 60,
    publishSubscription
  )

  const stopTrialExpiry = startTrialExpiry(
    ctx,
    accountClient,
    freePlanName !== undefined ? (workspace) => buildFreeSubscription(workspace) : undefined,
    { hourUtc: config.TrialExpiryHourUtc ?? 21, intervalMinutes: config.TrialExpiryIntervalMinutes },
    logOperation
  )

  // Fills the AI window on subscriptions predating it. Reads every active subscription, so it is
  // one-shot: opt in via RUN_WINDOW_BACKFILL, not on every restart of every replica.
  if (config.RunWindowBackfill === true) {
    void backfillWindowLimits(ctx, accountClient, (sub) => {
      // A trial gets the flat grant, like in createTrialSubscription.
      if (sub.status === SubscriptionStatus.Trialing && trialConfig?.windowMonthLimit !== undefined) {
        const limits = resolveLimits(sub.type, sub.plan, sub.providerData?.quantity as number | undefined)
        return limits != null ? { ...limits, windowMonthLimit: trialConfig.windowMonthLimit } : limits
      }
      // createManualSubscription writes no quantity -> using usersLimit instead.
      const seats = (sub.providerData?.quantity as number | undefined) ?? sub.limits?.usersLimit
      // Unknown seats on a per-seat plan -> skip.
      if (planConfig.plans?.[sub.plan]?.priceMonthlyPerUser != null && (seats == null || seats === 0)) {
        ctx.warn('AI window backfill: per-seat plan with unknown seats, skipping', {
          workspace: sub.workspaceUuid,
          plan: sub.plan,
          status: sub.status,
          provider: sub.provider
        })
        return undefined
      }
      return resolveLimits(sub.type, sub.plan, seats)
    }).catch((err: any) => {
      ctx.error('AI window backfill failed', { err })
    })
  }

  // ============ Generic Payment Service Endpoints ============
  // These endpoints are provider-agnostic and work with any payment provider

  /**
   * POST /api/v1/subscriptions/:workspace/subscribe
   * Create a subscription for a workspace
   * Body: SubscribeRequest { type: 'tier' | 'support', plan: string, ... }
   */
  app.post(
    '/api/v1/subscriptions/:workspace/subscribe',
    subscriptionRateLimiter,
    withToken,
    withLoginInfo,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (provider === undefined || serviceToken === undefined) {
        res.status(503).json({ error: 'Payment provider is not configured' })
        return
      }

      void handleRequest(
        ctx,
        'create-subscription',
        async (ctx) => {
          const workspaceUuid = req.token?.workspace
          const accountUuid = req.token?.account
          const request = req.body as SubscribeRequest
          const loginInfo = req.loginInfo as WorkspaceLoginInfo

          if (accountUuid === undefined) {
            res.status(401).json({ error: 'Missing account in token' })
            return
          }

          if (workspaceUuid === undefined) {
            res.status(401).json({ error: 'Missing workspace in token' })
            return
          }

          if (loginInfo?.workspaceUrl === undefined) {
            res.status(401).json({ error: 'Missing workspace url in login info' })
            return
          }

          if (request.type === undefined || request.plan === undefined) {
            res.status(400).json({ error: 'Missing required fields: type, plan' })
            return
          }

          // Activating Free subscription
          if (request.type === SubscriptionType.Tier && planConfig.plans?.[request.plan]?.free === true) {
            try {
              // Stop the recurrent charge at the provider before switching to free (same as /updatePlan):
              // otherwise the local DB shows free while the provider keeps billing.
              const subscriptions = await accountClient.getSubscriptions(workspaceUuid)
              const activeTier = subscriptions.find(
                (s) => s.type === SubscriptionType.Tier && s.status === SubscriptionStatus.Active
              )
              if (activeTier !== undefined && activeTier.provider === config.Provider) {
                await provider.cancelSubscription(ctx, activeTier.providerSubscriptionId)
              }
              const freeSub = await createFreeSubscription(workspaceUuid, accountUuid)
              if (freeSub === undefined) {
                res.status(500).json({ error: 'Free plan is not configured' })
                return
              }
              res.status(200).json({ instant: true, checkoutUrl: '' })
              return
            } catch (err) {
              ctx.error('Failed to create free subscription', { err })
              res.status(500).json({ error: 'Failed to create free subscription' })
              return
            }
          }

          if (request.type === SubscriptionType.Package) {
            const subscriptions = await accountClient.getSubscriptions(workspaceUuid)
            const activeTierPlan = subscriptions.find(
              (s) => s.type === SubscriptionType.Tier && s.status === SubscriptionStatus.Active
            )?.plan
            if (!isPackageEligible(request.plan, activeTierPlan)) {
              res.status(400).json({ error: 'Package not available on current plan' })
              return
            }

            // Cancel any active package of the same category before creating the new one.
            // Storage and AI packages are independent slots; same-category replacement must not stack.
            const requestedCategory: string = planConfig.packages?.[request.plan]?.category ?? 'storage'
            const sameCategory = subscriptions.filter((s) => {
              if (s.type !== SubscriptionType.Package || s.status !== SubscriptionStatus.Active) return false
              if (s.plan === request.plan) return false
              const cat: string = planConfig.packages?.[s.plan]?.category ?? 'storage'
              return cat === requestedCategory
            })
            // Downgrade to a smaller token budget is only allowed with no active package: cancel the
            // current one first (stays until period end), then subscribe to the smaller one.
            const newBudget = planTokenBudget(SubscriptionType.Package, request.plan)
            if (sameCategory.some((s) => planTokenBudget(SubscriptionType.Package, s.plan) > newBudget)) {
              res
                .status(400)
                .json({ error: 'Switching to a smaller package is only allowed after cancelling the current one.' })
              return
            }
            for (const existing of sameCategory) {
              try {
                if (existing.provider === config.Provider) {
                  const canceled = await provider.cancelSubscription(ctx, existing.providerSubscriptionId)
                  if (canceled !== null) {
                    await persistSubscription(canceled)
                  }
                } else {
                  const now = Date.now()
                  await persistSubscription({ ...existing, status: SubscriptionStatus.Canceled, canceledAt: now })
                }
              } catch (err) {
                // Must abort: proceeding to create a new package while the old one is still active
                // at the provider would leave the client with two active packages, billed twice.
                ctx.error('Failed to cancel same-category package', { plan: existing.plan, err })
                relayProviderError(res, err, 'Failed to cancel current package before switching')
                return
              }
            }
          }

          // Per-seat plans: validate the requested seat count. A package is a flat-price item — its
          // amount must never be multiplied by a client-supplied quantity, so force it to undefined.
          if (request.type === SubscriptionType.Tier) {
            const seats = await resolveSeatQuantity(request.plan, request.quantity, workspaceUuid)
            if (seats.error !== undefined) {
              res.status(400).json({ error: seats.error })
              return
            }
            request.quantity = seats.quantity
          } else {
            request.quantity = undefined
          }

          let createSubResponse: CheckoutResponse

          try {
            createSubResponse = await provider.createSubscription(
              ctx,
              request,
              workspaceUuid,
              loginInfo.workspaceUrl,
              accountUuid
            )
          } catch (err) {
            ctx.error('Failed to create subscription at provider', { err })
            relayProviderError(res, err, 'Failed to create subscription at provider')
            return
          }

          // Instant providers (mock) already activated the subscription — persist it now so the
          // client can just refetch instead of redirecting to a checkout page and polling.
          if (createSubResponse.instant === true) {
            const sub = await provider.getSubscriptionByCheckout(ctx, createSubResponse.checkoutId)
            if (sub !== null) {
              await persistSubscription(sub)
            }
          }

          res.status(200).json(createSubResponse)
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * POST /api/v1/subscriptions/:subscriptionId/cancel
   * Cancel a subscription
   * Authorization: Only workspace owner/admin can cancel
   */
  app.post(
    '/api/v1/subscriptions/:subscriptionId/cancel',
    subscriptionRateLimiter,
    withToken,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (requireProvider(provider, res)) return
      const activeProvider = provider

      void handleRequest(
        ctx,
        'cancel-subscription',
        async (ctx) => {
          const subscription = await loadOwnedSubscription(req, res)
          if (subscription === undefined) return

          const now = Date.now()
          const canceledSubscription = await runProviderOrLocal(ctx, res, subscription, {
            // Cancel at period end: keep the plan active/visible, only mark canceledAt.
            localPatch: { canceledAt: now },
            localLogMessage: 'Subscription canceled locally (provider mismatch)',
            providerCall: async (ctx, providerSubId) => await activeProvider.cancelSubscription(ctx, providerSubId),
            providerNotFoundMsg: 'Failed to cancel subscription at provider',
            providerErrorMsg: 'Failed to cancel subscription at provider'
          })
          if (canceledSubscription === undefined) return

          res.status(200).json(canceledSubscription)
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * POST /api/v1/subscriptions/:subscriptionId/uncancel
   * Uncancel a previously canceled subscription
   * Authorization: Only workspace owner/admin can uncancel
   */
  app.post(
    '/api/v1/subscriptions/:subscriptionId/uncancel',
    subscriptionRateLimiter,
    withToken,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (requireProvider(provider, res)) return
      const activeProvider = provider

      void handleRequest(
        ctx,
        'uncancel-subscription',
        async (ctx) => {
          const subscription = await loadOwnedSubscription(req, res)
          if (subscription === undefined) return

          const uncanceledSubscription = await runProviderOrLocal(ctx, res, subscription, {
            localPatch: { canceledAt: undefined, status: 'active' as SubscriptionStatus },
            localLogMessage: 'Subscription uncanceled locally (provider mismatch)',
            providerCall: async (ctx, providerSubId) => await activeProvider.uncancelSubscription(ctx, providerSubId),
            providerNotFoundMsg: 'Failed to uncancel subscription at provider',
            providerErrorMsg: 'Failed to uncancel subscription at provider'
          })
          if (uncanceledSubscription === undefined) return

          res.status(200).json(uncanceledSubscription)
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * POST /api/v1/subscriptions/:subscriptionId/updatePlan
   * Update a subscription to a different plan
   * Body: { plan: string } - The new plan name (e.g., 'start', 'standard', 'business')
   * Authorization: Only workspace owner/admin can update
   * Note: subscriptionId is the internal subscription ID, not the provider's ID
   */
  app.post(
    '/api/v1/subscriptions/:subscriptionId/updatePlan',
    subscriptionRateLimiter,
    withToken,
    withLoginInfo,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (requireProvider(provider, res)) return
      const activeProvider = provider

      void handleRequest(
        ctx,
        'update-plan',
        async (ctx) => {
          const { plan, quantity: requestedQuantity, period, force, recurrent } = req.body
          const loginInfo = req.loginInfo as WorkspaceLoginInfo

          if (plan === undefined || typeof plan !== 'string') {
            res.status(400).json({ error: 'Missing or invalid field: plan' })
            return
          }

          if (loginInfo?.workspaceUrl === undefined) {
            res.status(401).json({ error: 'Missing workspace url in login info' })
            return
          }

          const subscription = await loadOwnedSubscription(req, res)
          if (subscription === undefined) return

          const accountUuid = subscription.accountUuid ?? req.token?.account
          if (accountUuid == null) {
            res.status(400).json({ error: 'Missing account, cannot update plan' })
            return
          }

          if (subscription.type === SubscriptionType.Package) {
            const subscriptions = await accountClient.getSubscriptions(subscription.workspaceUuid)
            const activeTierPlan = subscriptions.find(
              (s) => s.type === SubscriptionType.Tier && s.status === SubscriptionStatus.Active
            )?.plan
            if (!isPackageEligible(plan, activeTierPlan)) {
              res.status(400).json({ error: 'Package not available on current plan' })
              return
            }
          }

          const targetIsFree = planConfig.plans?.[plan]?.free === true
          // Downgrade to a smaller token budget only when nothing active: to go smaller, cancel the
          // current plan (ends at period end) and subscribe fresh. Free is the cancel path, not a switch.
          if (!targetIsFree && subscription.status === SubscriptionStatus.Active) {
            if (planTokenBudget(subscription.type, plan) < planTokenBudget(subscription.type, subscription.plan)) {
              res
                .status(400)
                .json({ error: 'Switching to a smaller plan is only allowed after cancelling the current one.' })
              return
            }
          }
          if (targetIsFree) {
            try {
              // Downgrade to free is one user action: the paid cancel and the free activation share it.
              const actionId = `act-${Date.now().toString(36)}-${generateId().slice(0, 8)}`
              if (subscription.provider === config.Provider) {
                // Same provider: stop the recurrent charge / remove the card at the provider
                await provider.cancelSubscription(ctx, subscription.providerSubscriptionId)
              }
              // Mismatched provider: upsertSubscription inside createFreeSubscription will cancel all existing subs
              const freeSub = await createFreeSubscription(subscription.workspaceUuid, accountUuid, actionId)
              if (freeSub === undefined) {
                res.status(500).json({ error: 'Free plan is not configured' })
                return
              }
              res.status(200).json(freeSub)
            } catch (err) {
              ctx.error('Failed to create free subscription', { err })
              res.status(500).json({ error: 'Failed to create free subscription' })
            }
            return
          }

          // Per-seat plans: validate the requested seat count
          const seats = await resolveSeatQuantity(plan, requestedQuantity, subscription.workspaceUuid)
          if (seats.error !== undefined) {
            res.status(400).json({ error: seats.error })
            return
          }
          const quantity = seats.quantity

          // If the subscription was created by a different provider (e.g. manual/admin),
          // create a new subscription at the current provider — don't cancel the old one,
          // it stays active until the new payment is confirmed via webhook.
          if (subscription.provider !== config.Provider) {
            ctx.info('Subscription provider mismatch, creating new subscription', {
              existingProvider: subscription.provider,
              currentProvider: config.Provider,
              workspaceUuid: subscription.workspaceUuid,
              plan
            })
            try {
              const request: SubscribeRequest = { type: subscription.type, plan, quantity, period, force, recurrent }
              const checkoutResponse = await activeProvider.createSubscription(
                ctx,
                request,
                subscription.workspaceUuid,
                loginInfo.workspaceUrl,
                accountUuid
              )
              // Instant provider: persist the new subscription now (see createSubscription handler).
              if (checkoutResponse.instant === true) {
                const sub = await activeProvider.getSubscriptionByCheckout(ctx, checkoutResponse.checkoutId)
                if (sub !== null) {
                  await persistSubscription(sub)
                }
              }
              res.status(200).json(checkoutResponse)
            } catch (err) {
              ctx.error('Failed to create subscription at provider', { err })
              relayProviderError(res, err, 'Failed to create subscription at provider')
            }
            return
          }

          let updateResult: SubscriptionData | CheckoutResponse | null

          try {
            // Update via provider using the provider's subscription ID
            updateResult = await activeProvider.updateSubscriptionPlan(
              ctx,
              subscription.providerSubscriptionId,
              plan,
              subscription.type,
              loginInfo.workspaceUrl,
              accountUuid,
              quantity,
              period,
              recurrent,
              force
            )
          } catch (err) {
            ctx.error('Failed to update subscription at provider', { err })
            relayProviderError(res, err, 'Failed to update subscription at provider')
            return
          }

          if (updateResult === null) {
            res.status(404).json({ error: 'Failed to update subscription at provider' })
            return
          }

          // Check if it's a CheckoutResponse (free-to-paid upgrade)
          if ('checkoutUrl' in updateResult) {
            // Return checkout response for free-to-paid upgrades
            res.status(200).json(updateResult)
            return
          }

          // Pro-rata patch (no refund): when the current subscription was already paid, keep the
          // subscription's recurring amount = the new full price (what renews) but shift periodEnd by
          // the server-computed proration (downgrade credit extends it; monthly upgrade resets to 30d;
          // yearly upgrade leaves it). The one-time delta charge is returned separately for the UI/receipt.
          // All figures come from the current account subscription, so it is consistent across providers.
          const oldSeats = Number(subscription.providerData?.quantity ?? 1)
          const newSeats = quantity ?? oldSeats
          let prorationCharge: number | undefined
          // Proration applies to a same-plan seat change (per-seat tier) or a package swap — NOT to a
          // plain tier plan switch (start->business), which keeps the provider's fresh period/amount.
          const isSeatChange = subscription.type === SubscriptionType.Tier && plan === subscription.plan
          const isPackageChange = subscription.type === SubscriptionType.Package
          if (
            (isSeatChange || isPackageChange) &&
            subscription.amount != null &&
            subscription.periodStart != null &&
            subscription.periodEnd != null
          ) {
            const newFullPrice = planFullPrice(subscription.type, plan, newSeats, period)
            const common = {
              oldAmount: subscription.amount,
              periodStart: subscription.periodStart,
              periodEnd: subscription.periodEnd,
              now: Date.now(),
              newFullPrice
            }
            const pro =
              subscription.type === SubscriptionType.Package
                ? proratePackage(common)
                : prorateSeats({ ...common, oldSeats, newSeats })
            prorationCharge = pro.charge
            // Take the whole proration-computed period (start+end) so periodDays stays consistent for
            // a later change — the provider's own period (e.g. mock's now+30d) would otherwise desync.
            updateResult = {
              ...updateResult,
              amount: newFullPrice,
              periodStart: pro.periodStart,
              periodEnd: pro.periodEnd
            }
            ctx.info('applied proration', {
              id: subscription.id,
              oldSeats,
              newSeats,
              charge: pro.charge,
              isUpgrade: pro.isUpgrade,
              isYearly: pro.isYearly
            })
          }

          // It's a SubscriptionData - update was direct. Attach the new plan's limits
          // (providers may return without fresh limits) so enforcement and UI are correct.
          await persistSubscription(updateResult)

          res.status(200).json({ ...attachLimits(updateResult), prorationCharge })
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * POST /api/v1/subscriptions/:subscriptionId/previewPlanChange
   * Preview a seat/package change without mutating: returns the pro-rata one-time charge,
   * the resulting period end, and the seat floor. Body: { plan, quantity?, period? }.
   */
  app.post(
    '/api/v1/subscriptions/:subscriptionId/previewPlanChange',
    subscriptionRateLimiter,
    withToken,
    withLoginInfo,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      void handleRequest(
        ctx,
        'preview-plan-change',
        async (ctx) => {
          const { plan, quantity: requestedQuantity, period } = req.body
          if (plan === undefined || typeof plan !== 'string') {
            res.status(400).json({ error: 'Missing or invalid field: plan' })
            return
          }
          const subscription = await loadOwnedSubscription(req, res)
          if (subscription === undefined) return

          const minSeats = Math.max(await billableMembersCount(subscription.workspaceUuid), 1)
          const oldSeats = Number(subscription.providerData?.quantity ?? 1)
          const newSeats = requestedQuantity != null ? Math.max(Number(requestedQuantity), minSeats) : oldSeats
          const newFullPrice = planFullPrice(subscription.type, plan, newSeats, period)

          if (subscription.amount == null || subscription.periodStart == null || subscription.periodEnd == null) {
            // No paid period to prorate against (trial/free/manual): the change charges the full price.
            res.status(200).json({ charge: newFullPrice, periodEnd: undefined, minSeats, newSeats, isUpgrade: true })
            return
          }

          const common = {
            oldAmount: subscription.amount,
            periodStart: subscription.periodStart,
            periodEnd: subscription.periodEnd,
            now: Date.now(),
            newFullPrice
          }
          const pro =
            subscription.type === SubscriptionType.Package
              ? proratePackage(common)
              : prorateSeats({ ...common, oldSeats, newSeats })
          res.status(200).json({
            charge: pro.charge,
            periodEnd: pro.periodEnd,
            minSeats,
            newSeats,
            newFullPrice,
            isUpgrade: pro.isUpgrade,
            isYearly: pro.isYearly
          })
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * POST /api/v1/subscriptions/:subscriptionId/retry
   * Retry a failed payment for a subscription in past_due status.
   * Only supported by TBank (Stripe/Polar handle retries via built-in dunning).
   */
  app.post(
    '/api/v1/subscriptions/:subscriptionId/retry',
    subscriptionRateLimiter,
    withToken,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (requireProvider(provider, res)) return
      const activeProvider = provider

      void handleRequest(
        ctx,
        'retry-payment',
        async (ctx) => {
          const subscription = await loadOwnedSubscription(req, res)
          if (subscription === undefined) return

          if (subscription.status !== SubscriptionStatus.PastDue) {
            res.status(400).json({ error: 'Subscription is not in past_due status' })
            return
          }

          if (subscription.provider !== config.Provider) {
            // Provider mismatch — retry locally is not supported
            ctx.info('Retry not supported for provider-mismatched subscription', {
              id: subscription.id,
              provider: subscription.provider
            })
            res.status(400).json({ error: 'Retry not supported for this subscription' })
            return
          }

          try {
            const result = await activeProvider.retryPayment(ctx, subscription.providerSubscriptionId)
            if (result === null) {
              res.status(404).json({ error: 'Failed to retry payment' })
              return
            }
            await persistSubscription(result)
            res.json(result)
          } catch (err) {
            ctx.error('Failed to retry payment', { err })
            res.status(402).json({ error: 'Payment retry failed' })
          }
        },
        req,
        res,
        () => {}
      )
    }
  )

  /**
   * GET /api/v1/subscriptions/:subscriptionId
   * Get subscription details
   * Authorization: Only admin can view billing details directly from provider
   * (Subscription contains sensitive pricing and payment information)
   */
  app.get('/api/v1/subscriptions/:subscriptionId', withToken, withAdmin, (req: RequestWithAuth, res: Response) => {
    if (provider === undefined) {
      res.status(503).json({ error: 'Payment provider is not configured' })
      return
    }

    void handleRequest(
      ctx,
      'get-subscription',
      async (ctx) => {
        const subscriptionId = req.params.subscriptionId
        const subscription = await provider.getSubscription(ctx, subscriptionId)
        res.status(200).json(subscription)
      },
      req,
      res,
      () => {}
    )
  })

  /**
   * GET /api/v1/checkouts/:checkoutId/status
   * Get subscription status by checkout ID
   * Used to poll for subscription creation after successful checkout
   * If subscription is found in Polar but not in our DB, it will be upserted
   * If it exists in DB but has changed (newer modifiedAt), it will be updated
   * Authorization: Only authenticated workspace owners can check checkout status
   */
  app.get(
    '/api/v1/checkouts/:checkoutId/status',
    pollRateLimiter,
    withToken,
    withOwner,
    (req: RequestWithAuth, res: Response) => {
      if (provider === undefined) {
        res.status(503).json({ error: 'Payment provider is not configured' })
        return
      }

      // Disable caching for this endpoint - we want fresh data on every poll
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.set('Pragma', 'no-cache')
      res.set('Expires', '0')

      void handleRequest(
        ctx,
        'checkout-subscription-status',
        async (ctx) => {
          const checkoutId = req.params.checkoutId

          // Try to get subscription from provider by checkout ID
          const subscriptionData = await provider.getSubscriptionByCheckout(ctx, checkoutId)

          if (subscriptionData !== null) {
            // IDOR guard: getSubscriptionByCheckout is scoped by checkoutId only, not by caller. 404 hides existence.
            if (!ownsSubscription(req, subscriptionData)) {
              res.status(404).json({ checkoutId, subscriptionId: null, status: 'pending', subscription: null })
              return
            }

            // For providers that pre-create a subscription before payment confirmation
            // (e.g. TBank), check providerData.pending flag to determine actual completion
            const isCompleted = subscriptionData.providerData?.pending !== true

            // Only sync to DB if subscription is confirmed (webhook received)
            if (isCompleted) {
              try {
                // Get existing subscription from our DB if it exists
                const existingSubscription = await accountClient.getSubscriptionByProviderId(
                  subscriptionData.provider,
                  subscriptionData.providerSubscriptionId
                )

                // Check if we should upsert (doesn't exist or has changed)
                const shouldUpsert =
                  existingSubscription === null ||
                  (subscriptionData.providerData?.modifiedAt !== undefined &&
                    (existingSubscription?.providerData?.modifiedAt ?? 0) < subscriptionData.providerData.modifiedAt)

                if (shouldUpsert) {
                  await persistSubscription(subscriptionData)
                  ctx.info('Subscription upserted from checkout poll', {
                    checkoutId,
                    subscriptionId: subscriptionData.id,
                    isNew: existingSubscription === null
                  })
                }
              } catch (err) {
                ctx.error('Failed to sync subscription to DB', { checkoutId, err })
              }
            }

            res.status(200).json({
              checkoutId,
              subscriptionId: isCompleted ? subscriptionData.id : null,
              status: isCompleted ? 'completed' : 'pending',
              subscription: isCompleted ? subscriptionData : null
            })
            return
          }

          // A one-time purchase never becomes a subscription, so the provider has nothing to
          // report once it settles: its state lives in workspace_purchase. Without this the UI
          // polls forever on a package that was already granted.
          const workspace = req.token?.workspace
          if (workspace !== undefined) {
            try {
              const purchases = await accountClient.getPurchases(workspace)
              // checkoutId is the provider's checkout/order id, while paymentId is the settled
              // payment id (a different value for tbank), so match the order id kept in `raw` too.
              const purchase = purchases.find(
                (p) =>
                  (p.paymentId === checkoutId || p.raw?.providerData?.orderId === checkoutId) &&
                  (p.status === 'active' || p.status === 'consumed')
              )
              if (purchase !== undefined) {
                res.status(200).json({ checkoutId, subscriptionId: null, status: 'completed', purchase })
                return
              }
            } catch (err) {
              ctx.error('Failed to look up purchases for checkout', { checkoutId, err })
            }
          }

          // Subscription not yet found in provider
          res.status(200).json({
            checkoutId,
            subscriptionId: null,
            status: 'pending',
            subscription: null
          })
        },
        req,
        res,
        () => {}
      )
    }
  )

  app.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
  })

  return {
    app,
    ensureInitialSubscription,
    createFreeIfNoActiveTier,
    persistSubscription,
    close: () => {
      stopReconciliation()
      stopTrialExpiry()
    }
  }
}

export function listen (e: Express, port: number, host?: string): Server {
  const cb = (): void => {
    console.log(`Service started at ${host ?? '*'}:${port}`)
  }

  const server = host !== undefined ? e.listen(port, host, cb) : e.listen(port, cb)
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 1000
  server.headersTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 2000

  return server
}
