import { WorkspaceUuid } from '@hcengineering/core'

export interface BillingStats {
  liveKitStats: LiveKitStats
  datalakeStats: DatalakeStats
  aiStats: AiStats
  participantDailyStats: ParticipantDailyStats[]
  transcriptDailyStats: TranscriptDailyStats[]
}

export interface ParticipantDailyStats {
  day: string
  totalMinutes: number
  maxParticipants: number
  avgMeetingDurationMinutes: number
  maxMeetingDurationMinutes: number
}

export interface TranscriptDailyStats {
  day: string
  totalDurationSeconds: number
}

export interface DatalakeStats {
  count: number
  size: number
  byType: DatalakeStatsByType[]
}

export interface DatalakeStatsByType {
  type: string
  count: number
  size: number
}

export interface LiveKitStats {
  sessions: LiveKitSessionsStats[]
  egress: LiveKitEgressStats[]
}

export interface LiveKitSessionsStats {
  day: string
  bandwidth: number
  minutes: number
}

export interface LiveKitEgressStats {
  day: string
  minutes: number
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

export interface AiTranscriptStats {
  totalDurationSeconds: number
}

export interface AiTokensStats {
  reason: string
  totalTokens: number
  providerId?: string
  model?: string
  level?: string
}

export interface AiStats {
  transcript: AiTranscriptStats
  tokens: AiTokensStats[]
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
  // AI usage dimensions for per-provider/model/level reporting and provider pools.
  providerId?: string
  model?: string
  level?: string
  // clisr worker that served the request; empty for direct providers.
  clientId?: string
}

export interface LargestSpaceInfo {
  spaceId: string
  size: number
}

export type ProviderPoolKind = 'purchased' | 'local'
export type ProviderPoolPeriod = 'monthly' | 'daily' | 'none'

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

export interface ProviderPoolConfig {
  providerId: string
  model: string
  kind: ProviderPoolKind
  purchasedTokens: number
  period: ProviderPoolPeriod
  periodStart?: string
}

export interface AiModelRegistryEntry {
  providerId: string
  model: string
  level: string
  label: string
}

export interface LevelUsage {
  level: string
  label?: string
  tokens: number
}

export interface TokenWindowUsage {
  // Everything spent this period, whichever pool ends up paying for it.
  used: number
  // Monthly grant of the plan (per-seat plans: already multiplied by paid seats).
  limit: number
  resetAt: string | null
  levels: LevelUsage[]
}

export interface WorkspaceTokenWindows {
  workspace: WorkspaceUuid
  plan: string
  isFree?: boolean
  // UI label of the level paid plans keep using over the limit (the 'low' fallback).
  basicLevelLabel: string
  hasPackages: boolean
  // Spend against the monthly grant for the current period; the grant burns at period end.
  month: TokenWindowUsage
  // Purchased tokens left: never expire, charged once at period end for what overflowed the grant.
  balance: number
  // Tokens left across both pools; null = unlimited. <= 0 blocks AI requests.
  available: number | null
}

export interface BillingPricing {
  pricePer1000: Record<string, number>
  windowMonthLimitPerUser: number
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

export type AiTranscriptGroupBy = 'model' | 'level' | 'provider' | 'workspace' | 'client'

export interface AiTranscriptBreakdown {
  providerId?: string
  model?: string
  level?: string
  clientId?: string
  workspace?: WorkspaceUuid
  durationSeconds: number
}

// Per-model transcription usage record posted by aibot (mirrors AiTokensData).
export interface AiTranscriptUsageData {
  workspace: WorkspaceUuid
  durationSeconds: number
  date: string
  providerId?: string
  model?: string
  level?: string
  // clisr worker that served the transcription; empty for direct providers.
  clientId?: string
}

export interface AiWorkspaceBreakdown {
  workspace: WorkspaceUuid
  totalTokens: number
  rawTokens?: number
  // Rolling last-30-days usage — NOT aligned to the workspace's billing periodStart.
  usedRolling30d: number
  plan: string
  limitMonth: number
  byModel: Array<{ key: string, totalTokens: number, rawTokens?: number }>
  byLevel: Array<{ key: string, totalTokens: number, rawTokens?: number }>
}
