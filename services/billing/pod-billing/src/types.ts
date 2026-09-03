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

import { MeasureContext, type WorkspaceUuid } from '@hcengineering/core'

export interface LiveKitSessionsUsageData {
  day: string
  bandwidth: number
  minutes: number
}

export interface LiveKitEgressUsageData {
  day: string
  minutes: number
}

export interface LiveKitUsageData {
  sessions: LiveKitSessionsUsageData[]
  egress: LiveKitEgressUsageData[]
}

export interface LiveKitSessionData {
  workspace: string
  room: string
  sessionId: string
  sessionStart: string
  sessionEnd: string
  bandwidth: number
  minutes: number
}

export interface LiveKitEgressData {
  workspace: string
  room: string
  egressId: string
  egressStart: string
  egressEnd: string
  duration: number
}

export interface LiveKitParticipantSessionData {
  workspace: string
  participantId: string
  sessionId: string
  room: string
  joinedAt: string
  leftAt: string
  durationSeconds: number
}

export interface ParticipantMinutesUsage {
  totalMinutes: number
}

export interface ParticipantDailyUsage {
  day: string
  totalMinutes: number
  maxParticipants: number
  avgMeetingDurationMinutes: number
  maxMeetingDurationMinutes: number
}

export interface AiTranscriptUsage {
  totalDurationSeconds: number
}

export interface AiTokensUsage {
  reason: string
  totalTokens: number
  providerId?: string
  model?: string
  level?: string
}

export type AiTokensGroupBy = 'model' | 'level' | 'provider' | 'workspace' | 'client'

export interface AiTokensBreakdown {
  providerId?: string
  model?: string
  level?: string
  clientId?: string
  workspace?: WorkspaceUuid
  totalTokens: number
  rawTokens?: number
}

export interface ProviderTokenTotal {
  providerId: string
  model: string
  // Billing-multiplied tokens (for the user-facing spend view).
  totalTokens: number
  // Real tokens spent at the provider (for the global provider-budget pool).
  rawTokens: number
}

// Per-workspace AI spend roll-up for the admin estimation table: total tokens over the
// period + current rolling-window usage + per-model/level split (for drill-down).
export interface AiWorkspaceBreakdown {
  workspace: WorkspaceUuid
  totalTokens: number
  rawTokens?: number
  // Rolling last-30-days usage — NOT aligned to the workspace's billing periodStart.
  usedRolling30d: number
  byModel: Array<{ key: string, totalTokens: number, rawTokens?: number }>
  byLevel: Array<{ key: string, totalTokens: number, rawTokens?: number }>
}

// Token usage for a single rolling window (used vs limit). limit 0 = unlimited.
// resetAt: ISO time the current 30-day period (from periodStart) ends and usage resets (null when not over the limit).
export interface LevelUsage {
  level: string
  tokens: number
}

export interface TokenWindowUsage {
  used: number
  limit: number
  resetAt: string | null
  // Spend split by AI level within this window (for the usage popup, e.g. "30% pro / 70% low").
  levels: LevelUsage[]
}

// Rolling window aibot enforces per-workspace.
export interface WorkspaceTokenWindows {
  workspace: WorkspaceUuid
  month: TokenWindowUsage
}

// Purchased-token pool: one-time top-ups and package grants land here and never expire.
// Spent before the tier window via hourly absorption in LimitsEngine.
export interface TokenBalance {
  workspace: WorkspaceUuid
  remainingTokens: number
  // Hour boundary up to which usage has been absorbed from this balance.
  absorbedUntil: string | null
  // Tokens absorbed within the tier period starting at periodStart.
  absorbedPeriod: number
  periodStart: string
}

export type ProviderPoolKind = 'purchased' | 'local'
export type ProviderPoolPeriod = 'monthly' | 'daily' | 'none'

// A global token budget scoped to one (providerId, model). model '' = whole provider.
export interface ProviderPool {
  providerId: string
  model: string
  kind: ProviderPoolKind
  purchasedTokens: number
  period: ProviderPoolPeriod
  periodStart: string
  usedTokens: number
  exhausted: boolean
  notified80: boolean
  notified100: boolean
}

// Admin-set fields when configuring a purchased pool (used left to recompute).
export interface ProviderPoolConfig {
  providerId: string
  model: string
  kind: ProviderPoolKind
  purchasedTokens: number
  period: ProviderPoolPeriod
  periodStart?: string
}

// aibot model registry entry (pushed on startup) so the admin UI can list
// (provider, model) pairs to set pool limits before any spend exists.
export interface AiModelRegistryEntry {
  providerId: string
  model: string
  level: string
  label: string
}

export interface AiUsageData {
  transcript: AiTranscriptUsage
  tokens: AiTokensUsage[]
}

export interface AiTranscriptDailyUsage {
  day: string
  totalDurationSeconds: number
}

export interface AiTranscriptData {
  workspace: WorkspaceUuid
  day: string
  lastRequestId: string
  lastStartTime: string
  durationSeconds: number
  usd: number
}

export interface AiTokensData {
  workspace: WorkspaceUuid
  reason: string
  tokens: number
  rawTokens?: number
  date: string
  providerId?: string
  model?: string
  level?: string
  clientId?: string
}

export type AiTranscriptGroupBy = AiTokensGroupBy

// Per-model ASR transcription breakdown (mirrors AiTokensBreakdown).
export interface AiTranscriptBreakdown {
  providerId?: string
  model?: string
  level?: string
  clientId?: string
  workspace?: WorkspaceUuid
  durationSeconds: number
}

// Per-model transcription usage record pushed by aibot (mirrors AiTokensData).
export interface AiTranscriptUsageData {
  workspace: WorkspaceUuid
  durationSeconds: number
  date: string
  providerId?: string
  model?: string
  level?: string
  clientId?: string
}

export interface BillingDB {
  getLiveKitStats: (ctx: MeasureContext, workspace: WorkspaceUuid, start: Date, end: Date) => Promise<LiveKitUsageData>
  listLiveKitSessions: (ctx: MeasureContext, workspace: WorkspaceUuid) => Promise<LiveKitSessionData[] | null>
  listLiveKitEgress: (ctx: MeasureContext, workspace: WorkspaceUuid) => Promise<LiveKitEgressData[] | null>
  setLiveKitSessions: (ctx: MeasureContext, data: LiveKitSessionData[]) => Promise<void>
  setLiveKitEgress: (ctx: MeasureContext, data: LiveKitEgressData[]) => Promise<void>

  pushParticipantSessions: (ctx: MeasureContext, data: LiveKitParticipantSessionData[]) => Promise<void>
  getParticipantMinutes: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ) => Promise<ParticipantMinutesUsage>
  getParticipantDailyStats: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ) => Promise<ParticipantDailyUsage[]>

  pushAiTranscriptData: (ctx: MeasureContext, data: AiTranscriptData[]) => Promise<void>
  getAiTranscriptLastData: (ctx: MeasureContext) => Promise<AiTranscriptData | undefined>
  getAiTranscriptStats: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ) => Promise<AiTranscriptUsage>
  getAiTranscriptDailyStats: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ) => Promise<AiTranscriptDailyUsage[]>

  pushAiTokensData: (ctx: MeasureContext, data: AiTokensData[]) => Promise<void>
  getAiTokensStats: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ) => Promise<AiTokensUsage[]>

  // Per-model ASR transcription detail (admin breakdown only, no pool enforcement).
  pushTranscriptUsage: (ctx: MeasureContext, data: AiTranscriptUsageData[]) => Promise<void>
  getAiTranscriptBreakdown: (
    ctx: MeasureContext,
    groupBy: AiTranscriptGroupBy,
    start?: Date,
    end?: Date
  ) => Promise<AiTranscriptBreakdown[]>

  // usage-delta accumulation (idempotent by ref); returns true if delta was new
  accumulateUsageDelta: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number,
    ref: string
  ) => Promise<boolean>
  cleanupUsageDeltaDedup: (ctx: MeasureContext, retentionDays: number) => Promise<void>

  // per-workspace per-category limit state
  getLimitState: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    category: LimitCategory
  ) => Promise<WorkspaceLimitState | undefined>
  upsertLimitState: (ctx: MeasureContext, state: WorkspaceLimitState) => Promise<void>
  getAllExhaustedStates: (ctx: MeasureContext) => Promise<WorkspaceLimitState[]>

  // Admin-wide token breakdown across all workspaces, grouped by a dimension.
  getAiTokensBreakdown: (
    ctx: MeasureContext,
    groupBy: AiTokensGroupBy,
    providerId?: string,
    start?: Date,
    end?: Date
  ) => Promise<AiTokensBreakdown[]>
  // Per-workspace spend roll-up (total + monthly window usage + per-model/level split).
  getWorkspaceBreakdown: (
    ctx: MeasureContext,
    start?: Date,
    end?: Date,
    limit?: number,
    offset?: number
  ) => Promise<AiWorkspaceBreakdown[]>
  // Per-level token totals in a calendar billing period (usage popup breakdown).
  getWorkspaceLevelUsage: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ) => Promise<Array<{ level: string, label: string, tokens: number }>>
  // Total tokens spent per provider in a period (for provider-pool used).
  getProviderTokenTotals: (ctx: MeasureContext, start?: Date, end?: Date) => Promise<ProviderTokenTotal[]>

  // Provider token pools (purchased upstream, shared across all workspaces), keyed per (provider, model).
  listProviderPools: (ctx: MeasureContext) => Promise<ProviderPool[]>
  // Admin upsert of pool config; resets notify flags + used when period restarts.
  upsertProviderPool: (ctx: MeasureContext, config: ProviderPoolConfig) => Promise<void>
  // Top-up: add `delta` purchased tokens to a pool and reopen it (clear exhausted/notify).
  addPurchasedTokens: (ctx: MeasureContext, providerId: string, model: string, delta: number) => Promise<void>
  // Recompute used/exhausted from getProviderTokenTotals; returns the updated pool plus whether a
  // threshold (80/100) was newly crossed this pass. Does not touch the notified flags.
  updateProviderPoolState: (
    ctx: MeasureContext,
    providerId: string,
    model: string,
    usedTokens: number
  ) => Promise<{ pool: ProviderPool, crossed80: boolean, crossed100: boolean }>
  // Records that the threshold alert went out. Written only after a successful send, so a failed
  // one is re-attempted next pass rather than silently dropped.
  markPoolNotified: (ctx: MeasureContext, providerId: string, model: string, percent: 80 | 100) => Promise<void>

  // aibot model registry: replace-all upsert (startup push) + list for the admin UI.
  replaceAiModelRegistry: (ctx: MeasureContext, entries: AiModelRegistryEntry[]) => Promise<void>
  listAiModelRegistry: (ctx: MeasureContext) => Promise<AiModelRegistryEntry[]>

  // Admin reset of spent tokens (does not touch limits): per (provider, model) pool, all pools, or a workspace.
  resetProviderPoolUsed: (ctx: MeasureContext, providerId: string, model: string) => Promise<void>
  resetAllProviderPoolsUsed: (ctx: MeasureContext) => Promise<void>
  resetWorkspaceUsed: (ctx: MeasureContext, workspace: WorkspaceUuid, periodStart: Date) => Promise<void>
  // Admin/test helper: force the workspace token usage to an exact value for the current period
  // by clearing the period's usage rows and inserting a single synthetic record.
  setWorkspaceUsed: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    value: number,
    level: string,
    periodStart: Date
  ) => Promise<void>

  // Purchased-token pool (per workspace).
  getTokenBalance: (ctx: MeasureContext, workspace: WorkspaceUuid) => Promise<TokenBalance | undefined>
  // Atomically add tokens to the balance. Idempotent by grantId (ledger PK): a redelivered
  // purchase event or a repeated package-period grant adds nothing and returns false.
  grantAiTokens: (ctx: MeasureContext, workspace: WorkspaceUuid, grantId: string, amount: number) => Promise<boolean>
  // Settle the finished pack period: decrement the balance by charge and roll period_start
  // forward, only while it is still behind newPeriodStart. A concurrent double settle (or a retry
  // after a committed attempt) is therefore a no-op; returns false when the row was already settled.
  settleTokenBalance: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    charge: number,
    absorbedUntil: string | null,
    absorbedPeriod: number,
    newPeriodStart: string
  ) => Promise<boolean>
}

// --- billing-usage queue ---
// Single topic (QueueTopic.BillingUsage) carries every billing event as a discriminated union on `kind`.

export type UsageMetric = 'tokens' | 'transcript' | 'storage' | 'meetingMinutes'
export type LimitCategory = 'disk' | 'tokens' | 'transcript' | 'meetingMinutes'

/** Discriminator for messages on the 'billing-usage' topic. Missing kind = Usage
 *  (back-compat: in-flight messages published before an upgrade carry no kind). */
export enum BillingMessageKind {
  Usage = 'usage',
  AiRegistry = 'ai-registry',
  AiTokensDetail = 'ai-tokens-detail'
}

/** Usage delta message on the 'billing-usage' topic (kind omitted for back-compat). */
export interface BillingUsageMessage {
  kind?: BillingMessageKind.Usage
  workspace: WorkspaceUuid
  metric: UsageMetric
  amount: number
  /** Idempotency key — duplicate ref for same workspace+metric is ignored. */
  ref: string
}

/** Structured LiveKit records pushed by love (session/egress/participant). */
export type LiveKitRecordMessage =
  | { kind: 'session', data: LiveKitSessionData[] }
  | { kind: 'egress', data: LiveKitEgressData[] }
  | { kind: 'participant', data: LiveKitParticipantSessionData[] }

/** aibot's (provider, model, level) catalog, replace-all, on the same topic. */
export interface AiModelRegistryMessage {
  kind: BillingMessageKind.AiRegistry
  entries: AiModelRegistryEntry[]
}

/** Per-(provider, model, level, client) token spend from aibot, for admin reporting. */
export interface AiTokensDetailMessage {
  kind: BillingMessageKind.AiTokensDetail
  data: AiTokensData[]
}

/** Everything published to the 'billing-usage' topic. Discriminated by `kind`. */
export type BillingMessage = BillingUsageMessage | LiveKitRecordMessage | AiModelRegistryMessage | AiTokensDetailMessage

/** Per-workspace per-category limit state stored in billing DB. */
export interface WorkspaceLimitState {
  workspace: WorkspaceUuid
  category: LimitCategory
  used: number
  limitValue: number // 0 = unlimited
  exhausted: boolean
}
