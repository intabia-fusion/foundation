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

interface RetryOptions {
  retries: number
  delay?: number
}

async function retry<T> (op: () => Promise<T>, { retries, delay }: RetryOptions): Promise<T> {
  let error: any
  while (retries > 0) {
    retries--
    try {
      return await op()
    } catch (err: any) {
      error = err
      if (retries !== 0 && delay !== undefined && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw error
}

export class RetryDB implements BillingDB {
  constructor (
    private readonly db: BillingDB,
    private readonly options: RetryOptions
  ) {}

  async getLiveKitStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<LiveKitUsageData> {
    return await retry(() => this.db.getLiveKitStats(ctx, workspace, start, end), this.options)
  }

  async listLiveKitSessions (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitSessionData[] | null> {
    return await retry(() => this.db.listLiveKitSessions(ctx, workspace), this.options)
  }

  async listLiveKitEgress (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitEgressData[] | null> {
    return await retry(() => this.db.listLiveKitEgress(ctx, workspace), this.options)
  }

  async setLiveKitSessions (ctx: MeasureContext, data: LiveKitSessionData[]): Promise<void> {
    await retry(() => this.db.setLiveKitSessions(ctx, data), this.options)
  }

  async setLiveKitEgress (ctx: MeasureContext, data: LiveKitEgressData[]): Promise<void> {
    await retry(() => this.db.setLiveKitEgress(ctx, data), this.options)
  }

  async pushParticipantSessions (ctx: MeasureContext, data: LiveKitParticipantSessionData[]): Promise<void> {
    await retry(() => this.db.pushParticipantSessions(ctx, data), this.options)
  }

  async getParticipantMinutes (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantMinutesUsage> {
    return await retry(() => this.db.getParticipantMinutes(ctx, workspace, start, end), this.options)
  }

  async getParticipantDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantDailyUsage[]> {
    return await retry(() => this.db.getParticipantDailyStats(ctx, workspace, start, end), this.options)
  }

  async pushAiTranscriptData (ctx: MeasureContext, data: AiTranscriptData[]): Promise<void> {
    await retry(() => this.db.pushAiTranscriptData(ctx, data), this.options)
  }

  async getAiTranscriptLastData (ctx: MeasureContext): Promise<AiTranscriptData | undefined> {
    return await retry(() => this.db.getAiTranscriptLastData(ctx), this.options)
  }

  async getAiTranscriptStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptUsage> {
    return await retry(() => this.db.getAiTranscriptStats(ctx, workspace, start, end), this.options)
  }

  async getAiTranscriptDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<AiTranscriptDailyUsage[]> {
    return await retry(() => this.db.getAiTranscriptDailyStats(ctx, workspace, start, end), this.options)
  }

  async pushAiTokensData (ctx: MeasureContext, data: AiTokensData[]): Promise<void> {
    await retry(() => this.db.pushAiTokensData(ctx, data), this.options)
  }

  async pushTranscriptUsage (ctx: MeasureContext, data: AiTranscriptUsageData[]): Promise<void> {
    await retry(() => this.db.pushTranscriptUsage(ctx, data), this.options)
  }

  async getAiTranscriptBreakdown (
    ctx: MeasureContext,
    groupBy: AiTranscriptGroupBy,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptBreakdown[]> {
    return await retry(() => this.db.getAiTranscriptBreakdown(ctx, groupBy, start, end), this.options)
  }

  async getAiTokensStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTokensUsage[]> {
    return await retry(() => this.db.getAiTokensStats(ctx, workspace, start, end), this.options)
  }

  async accumulateUsageDelta (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number,
    ref: string
  ): Promise<boolean> {
    return await retry(() => this.db.accumulateUsageDelta(ctx, workspace, metric, amount, ref), this.options)
  }

  async cleanupUsageDeltaDedup (ctx: MeasureContext, retentionDays: number): Promise<void> {
    await retry(() => this.db.cleanupUsageDeltaDedup(ctx, retentionDays), this.options)
  }

  async getLimitState (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    category: LimitCategory
  ): Promise<WorkspaceLimitState | undefined> {
    return await retry(() => this.db.getLimitState(ctx, workspace, category), this.options)
  }

  async upsertLimitState (ctx: MeasureContext, state: WorkspaceLimitState): Promise<void> {
    await retry(() => this.db.upsertLimitState(ctx, state), this.options)
  }

  async getAllExhaustedStates (ctx: MeasureContext): Promise<WorkspaceLimitState[]> {
    return await retry(() => this.db.getAllExhaustedStates(ctx), this.options)
  }

  async getAiTokensBreakdown (
    ctx: MeasureContext,
    groupBy: AiTokensGroupBy,
    providerId?: string,
    start?: Date,
    end?: Date
  ): Promise<AiTokensBreakdown[]> {
    return await retry(() => this.db.getAiTokensBreakdown(ctx, groupBy, providerId, start, end), this.options)
  }

  async getWorkspaceBreakdown (
    ctx: MeasureContext,
    start?: Date,
    end?: Date,
    limit?: number,
    offset?: number
  ): Promise<AiWorkspaceBreakdown[]> {
    return await retry(() => this.db.getWorkspaceBreakdown(ctx, start, end, limit, offset), this.options)
  }

  async getWorkspaceLevelUsage (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<Array<{ level: string, label: string, tokens: number }>> {
    return await retry(() => this.db.getWorkspaceLevelUsage(ctx, workspace, start, end), this.options)
  }

  async getProviderTokenTotals (ctx: MeasureContext, start?: Date, end?: Date): Promise<ProviderTokenTotal[]> {
    return await retry(() => this.db.getProviderTokenTotals(ctx, start, end), this.options)
  }

  async listProviderPools (ctx: MeasureContext): Promise<ProviderPool[]> {
    return await retry(() => this.db.listProviderPools(ctx), this.options)
  }

  async upsertProviderPool (ctx: MeasureContext, config: ProviderPoolConfig): Promise<void> {
    await retry(() => this.db.upsertProviderPool(ctx, config), this.options)
  }

  async addPurchasedTokens (ctx: MeasureContext, providerId: string, model: string, delta: number): Promise<void> {
    await retry(() => this.db.addPurchasedTokens(ctx, providerId, model, delta), this.options)
  }

  async updateProviderPoolState (
    ctx: MeasureContext,
    providerId: string,
    model: string,
    usedTokens: number
  ): Promise<{ pool: ProviderPool, crossed80: boolean, crossed100: boolean }> {
    return await retry(() => this.db.updateProviderPoolState(ctx, providerId, model, usedTokens), this.options)
  }

  async markPoolNotified (ctx: MeasureContext, providerId: string, model: string, percent: 80 | 100): Promise<void> {
    await retry(() => this.db.markPoolNotified(ctx, providerId, model, percent), this.options)
  }

  async replaceAiModelRegistry (ctx: MeasureContext, entries: AiModelRegistryEntry[]): Promise<void> {
    await retry(() => this.db.replaceAiModelRegistry(ctx, entries), this.options)
  }

  async listAiModelRegistry (ctx: MeasureContext): Promise<AiModelRegistryEntry[]> {
    return await retry(() => this.db.listAiModelRegistry(ctx), this.options)
  }

  async resetProviderPoolUsed (ctx: MeasureContext, providerId: string, model: string): Promise<void> {
    await retry(() => this.db.resetProviderPoolUsed(ctx, providerId, model), this.options)
  }

  async resetAllProviderPoolsUsed (ctx: MeasureContext): Promise<void> {
    await retry(() => this.db.resetAllProviderPoolsUsed(ctx), this.options)
  }

  async resetWorkspaceUsed (ctx: MeasureContext, workspace: WorkspaceUuid, periodStart: Date): Promise<void> {
    await retry(() => this.db.resetWorkspaceUsed(ctx, workspace, periodStart), this.options)
  }

  async setWorkspaceUsed (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    value: number,
    level: string,
    periodStart: Date
  ): Promise<void> {
    await retry(() => this.db.setWorkspaceUsed(ctx, workspace, value, level, periodStart), this.options)
  }

  async getTokenBalance (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<TokenBalance | undefined> {
    return await retry(() => this.db.getTokenBalance(ctx, workspace), this.options)
  }

  async grantAiTokens (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    grantId: string,
    amount: number
  ): Promise<boolean> {
    return await retry(() => this.db.grantAiTokens(ctx, workspace, grantId, amount), this.options)
  }

  async settleTokenBalance (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    charge: number,
    absorbedUntil: string | null,
    absorbedPeriod: number,
    newPeriodStart: string
  ): Promise<boolean> {
    return await retry(
      () => this.db.settleTokenBalance(ctx, workspace, charge, absorbedUntil, absorbedPeriod, newPeriodStart),
      this.options
    )
  }
}
