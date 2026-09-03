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
import {
  AiTokensBreakdown,
  AiWorkspaceBreakdown,
  AiTokensData,
  AiTokensGroupBy,
  AiTokensUsage,
  AiTranscriptData,
  AiTranscriptDailyUsage,
  AiTranscriptUsage,
  AiTranscriptGroupBy,
  AiTranscriptBreakdown,
  AiTranscriptUsageData,
  BillingDB,
  LiveKitEgressData,
  LiveKitParticipantSessionData,
  LiveKitSessionData,
  LiveKitUsageData,
  ParticipantDailyUsage,
  ParticipantMinutesUsage,
  type LimitCategory,
  type UsageMetric,
  type WorkspaceLimitState,
  ProviderPool,
  ProviderPoolConfig,
  AiModelRegistryEntry,
  ProviderTokenTotal,
  type TokenBalance
} from '../types'

export class LoggedDB implements BillingDB {
  constructor (
    private readonly ctx: MeasureContext,
    private readonly db: BillingDB
  ) {}

  async getLiveKitStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<LiveKitUsageData> {
    return await ctx.with('db.getLiveKitUsage', {}, () => this.db.getLiveKitStats(this.ctx, workspace, start, end))
  }

  async listLiveKitSessions (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitSessionData[] | null> {
    return await ctx.with('db.listLiveKitSessions', {}, () => this.db.listLiveKitSessions(this.ctx, workspace))
  }

  async listLiveKitEgress (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitEgressData[] | null> {
    return await ctx.with('db.listLiveKitEgress', {}, () => this.db.listLiveKitEgress(this.ctx, workspace))
  }

  async setLiveKitSessions (ctx: MeasureContext, data: LiveKitSessionData[]): Promise<void> {
    await ctx.with('db.setLiveKitSessions', {}, () => this.db.setLiveKitSessions(this.ctx, data))
  }

  async setLiveKitEgress (ctx: MeasureContext, data: LiveKitEgressData[]): Promise<void> {
    await ctx.with('db.setLiveKitEgress', {}, () => this.db.setLiveKitEgress(this.ctx, data))
  }

  async pushParticipantSessions (ctx: MeasureContext, data: LiveKitParticipantSessionData[]): Promise<void> {
    await ctx.with('db.pushParticipantSessions', {}, () => this.db.pushParticipantSessions(this.ctx, data))
  }

  async getParticipantMinutes (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantMinutesUsage> {
    return await ctx.with('db.getParticipantMinutes', {}, () =>
      this.db.getParticipantMinutes(this.ctx, workspace, start, end)
    )
  }

  async getParticipantDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantDailyUsage[]> {
    return await ctx.with('db.getParticipantDailyStats', {}, () =>
      this.db.getParticipantDailyStats(this.ctx, workspace, start, end)
    )
  }

  async pushAiTranscriptData (ctx: MeasureContext, data: AiTranscriptData[]): Promise<void> {
    await ctx.with('db.pushAiTranscriptData', {}, () => this.db.pushAiTranscriptData(this.ctx, data))
  }

  async getAiTranscriptLastData (ctx: MeasureContext): Promise<AiTranscriptData | undefined> {
    return await ctx.with('db.getAiTranscriptLastData', {}, () => this.db.getAiTranscriptLastData(this.ctx))
  }

  async getAiTranscriptStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptUsage> {
    return await ctx.with('db.getAiTranscriptStats', {}, () =>
      this.db.getAiTranscriptStats(this.ctx, workspace, start, end)
    )
  }

  async getAiTranscriptDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<AiTranscriptDailyUsage[]> {
    return await ctx.with('db.getAiTranscriptDailyStats', {}, () =>
      this.db.getAiTranscriptDailyStats(this.ctx, workspace, start, end)
    )
  }

  async pushAiTokensData (ctx: MeasureContext, data: AiTokensData[]): Promise<void> {
    await ctx.with('db.pushAiTokensData', {}, () => this.db.pushAiTokensData(ctx, data))
  }

  async pushTranscriptUsage (ctx: MeasureContext, data: AiTranscriptUsageData[]): Promise<void> {
    await ctx.with('db.pushTranscriptUsage', {}, () => this.db.pushTranscriptUsage(ctx, data))
  }

  async getAiTranscriptBreakdown (
    ctx: MeasureContext,
    groupBy: AiTranscriptGroupBy,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptBreakdown[]> {
    return await ctx.with('db.getAiTranscriptBreakdown', {}, () =>
      this.db.getAiTranscriptBreakdown(ctx, groupBy, start, end)
    )
  }

  async getAiTokensStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTokensUsage[]> {
    return await ctx.with('db.getAiTokensStats', {}, () => this.db.getAiTokensStats(ctx, workspace, start, end))
  }

  async accumulateUsageDelta (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number,
    ref: string
  ): Promise<boolean> {
    return await ctx.with('db.accumulateUsageDelta', {}, () =>
      this.db.accumulateUsageDelta(ctx, workspace, metric, amount, ref)
    )
  }

  async cleanupUsageDeltaDedup (ctx: MeasureContext, retentionDays: number): Promise<void> {
    await ctx.with('db.cleanupUsageDeltaDedup', {}, () => this.db.cleanupUsageDeltaDedup(ctx, retentionDays))
  }

  async getLimitState (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    category: LimitCategory
  ): Promise<WorkspaceLimitState | undefined> {
    return await ctx.with('db.getLimitState', {}, () => this.db.getLimitState(ctx, workspace, category))
  }

  async upsertLimitState (ctx: MeasureContext, state: WorkspaceLimitState): Promise<void> {
    await ctx.with('db.upsertLimitState', {}, () => this.db.upsertLimitState(ctx, state))
  }

  async getAllExhaustedStates (ctx: MeasureContext): Promise<WorkspaceLimitState[]> {
    return await ctx.with('db.getAllExhaustedStates', {}, () => this.db.getAllExhaustedStates(ctx))
  }

  async getAiTokensBreakdown (
    ctx: MeasureContext,
    groupBy: AiTokensGroupBy,
    providerId?: string,
    start?: Date,
    end?: Date
  ): Promise<AiTokensBreakdown[]> {
    return await ctx.with('db.getAiTokensBreakdown', {}, () =>
      this.db.getAiTokensBreakdown(ctx, groupBy, providerId, start, end)
    )
  }

  async getWorkspaceBreakdown (
    ctx: MeasureContext,
    start?: Date,
    end?: Date,
    limit?: number,
    offset?: number
  ): Promise<AiWorkspaceBreakdown[]> {
    return await ctx.with('db.getWorkspaceBreakdown', {}, () =>
      this.db.getWorkspaceBreakdown(ctx, start, end, limit, offset)
    )
  }

  async getWorkspaceLevelUsage (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<Array<{ level: string, label: string, tokens: number }>> {
    return await ctx.with('db.getWorkspaceLevelUsage', {}, () =>
      this.db.getWorkspaceLevelUsage(ctx, workspace, start, end)
    )
  }

  async getProviderTokenTotals (ctx: MeasureContext, start?: Date, end?: Date): Promise<ProviderTokenTotal[]> {
    return await ctx.with('db.getProviderTokenTotals', {}, () => this.db.getProviderTokenTotals(ctx, start, end))
  }

  async listProviderPools (ctx: MeasureContext): Promise<ProviderPool[]> {
    return await ctx.with('db.listProviderPools', {}, () => this.db.listProviderPools(ctx))
  }

  async upsertProviderPool (ctx: MeasureContext, config: ProviderPoolConfig): Promise<void> {
    await ctx.with('db.upsertProviderPool', {}, () => this.db.upsertProviderPool(ctx, config))
  }

  async addPurchasedTokens (ctx: MeasureContext, providerId: string, model: string, delta: number): Promise<void> {
    await ctx.with('db.addPurchasedTokens', {}, () => this.db.addPurchasedTokens(ctx, providerId, model, delta))
  }

  async updateProviderPoolState (
    ctx: MeasureContext,
    providerId: string,
    model: string,
    usedTokens: number
  ): Promise<{ pool: ProviderPool, crossed80: boolean, crossed100: boolean }> {
    return await ctx.with('db.updateProviderPoolState', {}, () =>
      this.db.updateProviderPoolState(ctx, providerId, model, usedTokens)
    )
  }

  async markPoolNotified (ctx: MeasureContext, providerId: string, model: string, percent: 80 | 100): Promise<void> {
    await ctx.with('db.markPoolNotified', {}, () => this.db.markPoolNotified(ctx, providerId, model, percent))
  }

  async replaceAiModelRegistry (ctx: MeasureContext, entries: AiModelRegistryEntry[]): Promise<void> {
    await ctx.with('db.replaceAiModelRegistry', {}, () => this.db.replaceAiModelRegistry(ctx, entries))
  }

  async listAiModelRegistry (ctx: MeasureContext): Promise<AiModelRegistryEntry[]> {
    return await ctx.with('db.listAiModelRegistry', {}, () => this.db.listAiModelRegistry(ctx))
  }

  async resetProviderPoolUsed (ctx: MeasureContext, providerId: string, model: string): Promise<void> {
    await ctx.with('db.resetProviderPoolUsed', {}, () => this.db.resetProviderPoolUsed(ctx, providerId, model))
  }

  async resetAllProviderPoolsUsed (ctx: MeasureContext): Promise<void> {
    await ctx.with('db.resetAllProviderPoolsUsed', {}, () => this.db.resetAllProviderPoolsUsed(ctx))
  }

  async resetWorkspaceUsed (ctx: MeasureContext, workspace: WorkspaceUuid, periodStart: Date): Promise<void> {
    await ctx.with('db.resetWorkspaceUsed', {}, () => this.db.resetWorkspaceUsed(ctx, workspace, periodStart))
  }

  async setWorkspaceUsed (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    value: number,
    level: string,
    periodStart: Date
  ): Promise<void> {
    await ctx.with('db.setWorkspaceUsed', {}, () => this.db.setWorkspaceUsed(ctx, workspace, value, level, periodStart))
  }

  async getTokenBalance (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<TokenBalance | undefined> {
    return await ctx.with('db.getTokenBalance', {}, () => this.db.getTokenBalance(ctx, workspace))
  }

  async grantAiTokens (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    grantId: string,
    amount: number
  ): Promise<boolean> {
    return await ctx.with('db.grantAiTokens', {}, () => this.db.grantAiTokens(ctx, workspace, grantId, amount))
  }

  async settleTokenBalance (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    charge: number,
    absorbedUntil: string | null,
    absorbedPeriod: number,
    newPeriodStart: string
  ): Promise<boolean> {
    return await ctx.with('db.settleTokenBalance', {}, () =>
      this.db.settleTokenBalance(ctx, workspace, charge, absorbedUntil, absorbedPeriod, newPeriodStart)
    )
  }
}
