//
// Copyright © 2025 Hardcore Engineering Inc.
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

import type { Request, Response } from 'express'
import { MeasureContext, Ref, Space, systemAccountUuid, WorkspaceUuid } from '@hcengineering/core'
import attachment from '@hcengineering/attachment'
import {
  LiveKitSessionData,
  BillingDB,
  LiveKitEgressData,
  LiveKitParticipantSessionData,
  AiUsageData,
  AiTranscriptData,
  AiTokensData,
  AiTokensGroupBy,
  AiWorkspaceBreakdown,
  ProviderPoolConfig,
  AiTranscriptGroupBy,
  AiTranscriptUsageData
} from './types'
import { generateToken } from '@hcengineering/server-token'
import {
  getClient as getAccountClient,
  grantsPlan,
  isFreePlan,
  SubscriptionStatus,
  SubscriptionType
} from '@hcengineering/account-client'
import { StorageConfig } from '@hcengineering/server-core'
import { createDatalakeClient, DatalakeConfig, WorkspaceStats, WorkspaceStatsByType } from '@hcengineering/datalake'
import { validate as uuidValidate } from 'uuid'
import { getClient } from './client'
import billingConfig from './config'
import { effectivePeriodStart, getPeriodStartDate, resolveTierLimits } from './limits'

function parseIntParam (req: Request, name: string): number | undefined {
  const v = req.query[name]
  if (typeof v !== 'string') return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

export async function handleListLiveKitSessions (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  res.status(200).json(await db.listLiveKitSessions(ctx, workspace))
}

export async function handleListLiveKitEgress (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  res.status(200).json(await db.listLiveKitEgress(ctx, workspace))
}

export async function handleSetLiveKitSessions (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as LiveKitSessionData[]
  await db.setLiveKitSessions(ctx, data)
  res.status(204).send()
}

export async function handleSetLiveKitEgress (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as LiveKitEgressData[]
  await db.setLiveKitEgress(ctx, data)
  res.status(204).send()
}

export async function handleGetStats (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const { fromDate, toDate } = parseDateParameters(req)
  const liveKitStats = await db.getLiveKitStats(ctx, workspace, fromDate, toDate)
  const datalakeStats = await collectDatalakeStats(ctx, workspace, storageConfigs)

  const aiStats: AiUsageData = {
    transcript: await db.getAiTranscriptStats(ctx, workspace, fromDate, toDate),
    tokens: await db.getAiTokensStats(ctx, workspace, fromDate, toDate)
  }
  const participantDailyStats = await db.getParticipantDailyStats(ctx, workspace, fromDate, toDate)
  const transcriptDailyStats = await db.getAiTranscriptDailyStats(ctx, workspace, fromDate, toDate)
  res.status(200).json({ liveKitStats, datalakeStats, aiStats, participantDailyStats, transcriptDailyStats })
}

export async function handleGetLiveKitStats (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const { fromDate, toDate } = parseDateParameters(req)
  res.status(200).json(await db.getLiveKitStats(ctx, workspace, fromDate, toDate))
}

export async function handleGetDatalakeStats (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  res.status(200).json(await collectDatalakeStats(ctx, workspace, storageConfigs))
}

export async function handleGetAiStats (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const { fromDate, toDate } = parseDateParameters(req)

  const usage: AiUsageData = {
    transcript: await db.getAiTranscriptStats(ctx, workspace, fromDate, toDate),
    tokens: await db.getAiTokensStats(ctx, workspace, fromDate, toDate)
  }

  res.status(200).json(usage)
}

export async function handleGetAiTranscriptLastData (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const last = await db.getAiTranscriptLastData(ctx)
  if (last === undefined) {
    res.status(404).send()
    return
  }
  res.status(200).json(last)
}

export async function handlePushAiTranscriptData (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as AiTranscriptData[]
  await db.pushAiTranscriptData(ctx, data)
  res.status(204).send()
}

export async function handlePushParticipantSessions (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as LiveKitParticipantSessionData[]
  await db.pushParticipantSessions(ctx, data)
  res.status(204).send()
}

export async function handlePushAiTokensData (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as AiTokensData[]
  await db.pushAiTokensData(ctx, data)
  res.status(204).send()
}

export async function handlePushTranscriptUsage (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const data = (await req.body) as AiTranscriptUsageData[]
  await db.pushTranscriptUsage(ctx, data)
  res.status(204).send()
}

export async function handleGetTranscriptUsage (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const groupBy = (req.query.groupBy as AiTranscriptGroupBy) ?? 'model'
  const { fromDate, toDate } = parseDateParameters(req)
  res.json(await db.getAiTranscriptBreakdown(ctx, groupBy, fromDate, toDate))
}

export interface LargestSpaceResult {
  spaceId: Ref<Space>
  size: number
}

export async function handleGetLargestSpaces (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const token = generateToken(systemAccountUuid, workspace, { service: 'billing', admin: 'true' })

  const client = await getClient(token, workspace)

  const attachments = await client.findAll(attachment.class.Attachment, {}, { projection: { space: 1, size: 1 } })

  const spaceSizes = new Map<Ref<Space>, number>()

  for (const att of attachments) {
    if (att.space != null && att.size != null) {
      const currentSize = spaceSizes.get(att.space) ?? 0
      spaceSizes.set(att.space, currentSize + att.size)
    }
  }

  const limit = 10
  const sortedSpaces: LargestSpaceResult[] = Array.from(spaceSizes.entries())
    .map(([spaceId, size]) => ({ spaceId, size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)

  res.status(200).json(sortedSpaces)
}

export async function collectDatalakeStats (
  ctx: MeasureContext,
  workspace: WorkspaceUuid,
  storageConfigs: StorageConfig[]
): Promise<WorkspaceStats & { byType: WorkspaceStatsByType[] }> {
  const result: WorkspaceStats & { byType: WorkspaceStatsByType[] } = {
    count: 0,
    size: 0,
    byType: []
  }

  const token = generateToken(systemAccountUuid, undefined, { service: 'billing' })

  const byTypeMap = new Map<string, { count: number, size: number }>()

  for (const storageConfig of storageConfigs) {
    if (storageConfig.kind !== 'datalake') {
      continue
    }
    const client = createDatalakeClient(storageConfig as DatalakeConfig, token)

    const [storageStats, statsByType] = await Promise.all([
      client.getWorkspaceStats(ctx, workspace),
      client.getWorkspaceStatsByType(ctx, workspace)
    ])

    result.count += storageStats.count
    result.size += storageStats.size

    for (const entry of statsByType) {
      const existing = byTypeMap.get(entry.type)
      if (existing !== undefined) {
        existing.count += entry.count
        existing.size += entry.size
      } else {
        byTypeMap.set(entry.type, { count: entry.count, size: entry.size })
      }
    }
  }

  result.byType = Array.from(byTypeMap.entries()).map(([type, stats]) => ({
    type,
    count: stats.count,
    size: stats.size
  }))

  return result
}

// Pricing + current window limits for the admin cost calculator.
export async function handleGetPricing (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  res.json({
    pricePer1000: billingConfig.ProviderPrices,
    windowMonthLimitPerUser: billingConfig.WindowMonthLimit,
    tokenPackageMultiplier: billingConfig.TokenPackageMultiplier
  })
}

export async function handleListProviderPools (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  res.json(await db.listProviderPools(ctx))
}

export async function handleUpsertProviderPool (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const config = (await req.body) as ProviderPoolConfig
  if (config?.providerId == null || config.providerId === '') {
    res.status(400).json({ message: 'providerId required' })
    return
  }
  await db.upsertProviderPool(ctx, { ...config, model: config.model ?? '' })
  res.status(204).send()
}

export async function handleAddProviderPoolTokens (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const body = (await req.body) as { providerId?: string, model?: string, delta?: number }
  if (body?.providerId == null || body.providerId === '' || typeof body.delta !== 'number') {
    res.status(400).json({ message: 'providerId and numeric delta required' })
    return
  }
  await db.addPurchasedTokens(ctx, body.providerId, body.model ?? '', body.delta)
  res.status(204).send()
}

export async function handleResetPoolUsed (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const body = (await req.body) as { providerId?: string, model?: string, all?: boolean }
  if (body?.all === true) {
    await db.resetAllProviderPoolsUsed(ctx)
    res.status(204).send()
    return
  }
  if (body?.providerId == null || body.providerId === '') {
    res.status(400).json({ message: 'providerId required (or all=true)' })
    return
  }
  await db.resetProviderPoolUsed(ctx, body.providerId, body.model ?? '')
  res.status(204).send()
}

export async function handleResetWorkspaceUsed (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = req.params.workspace as WorkspaceUuid
  if (workspace == null || workspace === '') {
    res.status(400).json({ message: 'workspace required' })
    return
  }
  await db.resetWorkspaceUsed(ctx, workspace)
  res.status(204).send()
}

// Admin/test: set the workspace token usage to an exact value (body: { value: number }).
export async function handleSetWorkspaceUsed (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = req.params.workspace as WorkspaceUuid
  if (workspace == null || workspace === '') {
    res.status(400).json({ message: 'workspace required' })
    return
  }
  const body = req.body as { value?: unknown, level?: unknown }
  const value = Number(body?.value)
  if (!Number.isFinite(value) || value < 0) {
    res.status(400).json({ message: 'value must be a non-negative number' })
    return
  }
  const level = typeof body?.level === 'string' && body.level !== '' ? body.level : 'low'
  await db.setWorkspaceUsed(ctx, workspace, Math.floor(value), level)
  res.status(204).send()
}

export async function handleListAiModelRegistry (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  res.json(await db.listAiModelRegistry(ctx))
}

export async function handleGetTokenUsage (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const groupBy = (req.query.groupBy as AiTokensGroupBy) ?? 'model'
  const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined
  const { fromDate, toDate } = parseDateParameters(req)
  res.json(await db.getAiTokensBreakdown(ctx, groupBy, providerId, fromDate, toDate))
}

export async function handleGetWorkspaceBreakdown (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const { fromDate, toDate } = parseDateParameters(req)
  const limit = parseIntParam(req, 'limit')
  const offset = parseIntParam(req, 'offset')
  const rows = await db.getWorkspaceBreakdown(ctx, fromDate, toDate, limit, offset)
  const augmented = await Promise.all(
    rows.map(
      async (r): Promise<AiWorkspaceBreakdown & { plan: string, limitMonth: number }> => ({
        ...r,
        ...(await resolveWorkspacePlan(ctx, db, r.workspace))
      })
    )
  )
  res.json(augmented)
}

// Used tokens for a workspace in the current calendar period [periodStart, now). Same
// periodStart as LimitService.computeUsed, so the widget, aibot enforcement and the limit
// state all agree. Limit is added here from tier + packages + rollover.
export async function handleGetWorkspaceTokenWindows (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const { plan, hasPackages, limitMonth, baseMonth, packagesMonth, remaining, isFree, periodStart } =
    await resolveWorkspacePlan(ctx, db, workspace)
  const periodEnd = new Date()
  const [stats, levels, registry] = await Promise.all([
    db.getAiTokensStats(ctx, workspace, periodStart, periodEnd),
    db.getWorkspaceLevelUsage(ctx, workspace, periodStart, periodEnd),
    db.listAiModelRegistry(ctx)
  ])
  const usedMonth = stats.map((s) => s.totalTokens).reduce((a, b) => a + b, 0)
  // Level that paid plans keep using over the limit (the cheapest 'low' fallback). UI label.
  const basicLevelLabel = registry.find((r) => r.level === 'low')?.label ?? ''
  res.json({
    workspace,
    plan,
    isFree,
    basicLevelLabel,
    hasPackages,
    month: {
      used: usedMonth,
      limit: limitMonth,
      base: baseMonth,
      packages: packagesMonth,
      rollover: remaining,
      windowHours: 24 * 30,
      resetAt: new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      levels
    }
  })
}

// aibot applies a one-time ai-token-reset purchase here: anchor the window at now (or a given ms).
// Idempotent by purchaseId so a redelivered PurchaseActivated event resets only once.
export async function handleResetAiWindow (
  ctx: MeasureContext,
  db: BillingDB,
  storageConfigs: StorageConfig[],
  req: Request,
  res: Response
): Promise<void> {
  const workspace = getWorkspaceUuid(req)
  const body = (req.body ?? {}) as { resetAtMs?: number, purchaseId?: string }
  const resetAtMs = typeof body.resetAtMs === 'number' ? body.resetAtMs : Date.now()
  const purchaseId = body.purchaseId ?? ''
  const applied = await db.setAiWindowReset(ctx, workspace, resetAtMs, purchaseId)
  res.json({ applied, resetAtMs })
}

// Calendar-period limit + plan name + periodStart for a workspace. Falls back to env defaults on outage (fail-open).
export async function resolveWorkspacePlan (
  ctx: MeasureContext,
  db: BillingDB,
  workspace: WorkspaceUuid
): Promise<{
    plan: string
    limitMonth: number
    baseMonth: number
    packagesMonth: number
    remaining: number
    hasPackages: boolean
    isFree: boolean
    periodStart: Date
  }> {
  try {
    const token = generateToken(systemAccountUuid, workspace, { service: 'billing', admin: 'true' })
    const account = getAccountClient(billingConfig.AccountsUrl, token)
    const subs = await account.getSubscriptions(workspace, false)
    const limits = resolveTierLimits(subs)
    const baseMonth = limits?.windowMonthLimit ?? billingConfig.WindowMonthLimit
    // Active AI-token packages grant a monthly token quota (tokenLimit) on top of the tier
    // window; unused quota rolls into `remaining` (token_balance) at period end.
    const pkgs = subs.filter((s) => s.type === SubscriptionType.Package && s.status === SubscriptionStatus.Active)
    const packagesMonth = pkgs.reduce((acc, s) => acc + (s.limits?.tokenLimit ?? 0), 0)
    const grantingTier = subs
      .filter((s) => s.type === SubscriptionType.Tier && grantsPlan(s))
      .sort((a, b) => (b.createdOn ?? 0) - (a.createdOn ?? 0))[0]
    const plan = grantingTier?.plan ?? 'free'
    const isFree = isFreePlan(grantingTier)
    const balance = await db.getTokenBalance(ctx, workspace)
    const remaining = balance?.remainingTokens ?? 0
    // 0 = unlimited; adding a package/rollover balance to an unlimited window keeps it unlimited.
    const limitMonth = baseMonth === 0 ? 0 : baseMonth + packagesMonth + remaining
    // A one-time ai-token-reset purchase (applied by aibot) shifts the window start forward, zeroing used.
    const resetAt = await db.getAiWindowReset(ctx, workspace)
    const periodStart = getPeriodStartDate(effectivePeriodStart(grantingTier?.periodStart, resetAt))
    return { plan, limitMonth, baseMonth, packagesMonth, remaining, hasPackages: pkgs.length > 0, isFree, periodStart }
  } catch (err: any) {
    ctx.warn('failed to resolve workspace plan, using env defaults', { workspace, error: err?.message })
    return {
      plan: 'unknown',
      limitMonth: billingConfig.WindowMonthLimit,
      baseMonth: billingConfig.WindowMonthLimit,
      packagesMonth: 0,
      remaining: 0,
      hasPackages: false,
      isFree: false,
      periodStart: getPeriodStartDate(undefined)
    }
  }
}

function getWorkspaceUuid (req: Request): WorkspaceUuid {
  const { workspace } = req.params
  if (uuidValidate(workspace)) {
    return workspace as WorkspaceUuid
  }
  throw new Error('Unknown workspace')
}

function parseDateParameters (req: Request): { fromDate: Date, toDate: Date } {
  let fromDate: Date
  if (typeof req.query.fromDate === 'string') {
    fromDate = new Date(Date.parse(req.query.fromDate))
  } else {
    fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  }

  let toDate: Date
  if (typeof req.query.toDate === 'string') {
    toDate = new Date(Date.parse(req.query.toDate))
  } else {
    toDate = new Date(Date.now())
  }

  return { fromDate, toDate }
}
