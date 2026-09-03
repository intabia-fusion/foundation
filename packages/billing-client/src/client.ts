import { concatLink, WorkspaceUuid } from '@hcengineering/core'
import { BillingError, NetworkError } from './error'
import {
  AiTokensBreakdown,
  AiTokensData,
  AiTokensGroupBy,
  AiWorkspaceBreakdown,
  BillingPricing,
  AiTranscriptData,
  AiTranscriptGroupBy,
  AiTranscriptBreakdown,
  AiTranscriptUsageData,
  BillingStats,
  DatalakeStats,
  LargestSpaceInfo,
  LiveKitEgressData,
  LiveKitEgressStats,
  LiveKitParticipantSessionData,
  LiveKitSessionData,
  LiveKitSessionsStats,
  LiveKitStats,
  ProviderPool,
  ProviderPoolConfig,
  AiModelRegistryEntry,
  WorkspaceTokenWindows
} from './types'

/** @public */
export function getClient (billingUrl?: string, token?: string): BillingClient {
  if (billingUrl === undefined || billingUrl == null || billingUrl === '') {
    throw new Error('Billing url not specified')
  }
  if (token === undefined || token == null || token === '') {
    throw new Error('Token not specified')
  }

  return new BillingClient(billingUrl, token)
}

export class BillingClient {
  private readonly headers: Record<string, string>

  constructor (
    private readonly endpoint: string,
    private readonly token: string
  ) {
    this.headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }

  async getBillingStats (workspace: WorkspaceUuid): Promise<BillingStats> {
    const path = `/api/v1/${workspace}/stats`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as BillingStats
  }

  async getDatalakeStats (workspace: WorkspaceUuid): Promise<DatalakeStats> {
    const path = `/api/v1/${workspace}/datalake/stats`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as DatalakeStats
  }

  async getLiveKitStats (workspace: WorkspaceUuid): Promise<LiveKitStats> {
    const path = `/api/v1/${workspace}/livekit/stats`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as LiveKitStats
  }

  async getLiveKitSessionsStats (workspace: WorkspaceUuid): Promise<LiveKitSessionsStats[]> {
    const path = `/api/v1/${workspace}/livekit/sessions`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as LiveKitSessionsStats[]
  }

  async getLiveKitEgressStats (workspace: WorkspaceUuid): Promise<LiveKitEgressStats[]> {
    const path = `/api/v1/${workspace}/livekit/egress`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as LiveKitEgressStats[]
  }

  async postLiveKitSessions (sessions: LiveKitSessionData[]): Promise<void> {
    const path = '/api/v1/livekit/sessions'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(sessions)
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async postLiveKitEgress (egress: LiveKitEgressData[]): Promise<void> {
    const path = '/api/v1/livekit/egress'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(egress)
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async postParticipantSessions (data: LiveKitParticipantSessionData[]): Promise<void> {
    const path = '/api/v1/livekit/participants'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(data)
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async getAiTranscriptLastData (): Promise<AiTranscriptData | undefined> {
    const path = '/api/v1/ai/transcript/last'
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as AiTranscriptData | undefined
  }

  async postAiTranscriptData (data: AiTranscriptData[]): Promise<void> {
    const path = '/api/v1/ai/transcript'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(data)

    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async postAiTokensData (data: AiTokensData[]): Promise<void> {
    const path = '/api/v1/ai/tokens'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(data)

    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async postTranscriptUsage (data: AiTranscriptUsageData[]): Promise<void> {
    const path = '/api/v1/ai/transcript-usage'
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify(data)

    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async getTranscriptUsage (groupBy: AiTranscriptGroupBy, from?: Date, to?: Date): Promise<AiTranscriptBreakdown[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/transcript-usage'))
    url.searchParams.set('groupBy', groupBy)
    if (from !== undefined) url.searchParams.set('fromDate', from.toISOString())
    if (to !== undefined) url.searchParams.set('toDate', to.toISOString())
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as AiTranscriptBreakdown[]
  }

  async listProviderPools (): Promise<ProviderPool[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/pools'))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as ProviderPool[]
  }

  async upsertProviderPool (config: ProviderPoolConfig): Promise<void> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/pools'))
    const body = JSON.stringify(config)
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async addProviderPoolTokens (providerId: string, model: string, delta: number): Promise<void> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/pools/add'))
    const body = JSON.stringify({ providerId, model, delta })
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async listAiModelRegistry (): Promise<AiModelRegistryEntry[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/registry'))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as AiModelRegistryEntry[]
  }

  // aibot reads global per-model pools to enforce upstream token limits.
  async getAiPools (): Promise<ProviderPool[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/ai/pools'))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as ProviderPool[]
  }

  async getTokenUsage (
    groupBy: AiTokensGroupBy,
    providerId?: string,
    from?: Date,
    to?: Date
  ): Promise<AiTokensBreakdown[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/token-usage'))
    url.searchParams.set('groupBy', groupBy)
    if (providerId !== undefined && providerId !== '') {
      url.searchParams.set('providerId', providerId)
    }
    if (from !== undefined) url.searchParams.set('fromDate', from.toISOString())
    if (to !== undefined) url.searchParams.set('toDate', to.toISOString())
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as AiTokensBreakdown[]
  }

  async getWorkspaceBreakdown (limit?: number, offset?: number): Promise<AiWorkspaceBreakdown[]> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/workspace-breakdown'))
    if (limit !== undefined) url.searchParams.set('limit', String(limit))
    if (offset !== undefined) url.searchParams.set('offset', String(offset))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as AiWorkspaceBreakdown[]
  }

  // Reset spent tokens (limits unchanged). Pass all=true for every pool, else (provider, model).
  async resetPoolUsed (providerId?: string, model?: string, all?: boolean): Promise<void> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/pools/reset'))
    const body = JSON.stringify({ providerId, model, all })
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async resetWorkspaceUsed (workspace: string): Promise<void> {
    const url = new URL(concatLink(this.endpoint, `/api/v1/admin/${workspace}/reset`))
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers } })
  }

  // Admin/test: set the workspace token usage to an exact value at a given level.
  async setWorkspaceUsed (workspace: string, value: number, level: string): Promise<void> {
    const url = new URL(concatLink(this.endpoint, `/api/v1/admin/${workspace}/set-used`))
    const body = JSON.stringify({ value, level })
    await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
  }

  async getPricing (): Promise<BillingPricing> {
    const url = new URL(concatLink(this.endpoint, '/api/v1/admin/pricing'))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as BillingPricing
  }

  async getWorkspaceTokenWindows (workspace: WorkspaceUuid): Promise<WorkspaceTokenWindows> {
    const path = `/api/v1/${workspace}/ai/tokens/windows`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as WorkspaceTokenWindows
  }

  // Add tokens to the workspace period budget (one-time purchase effect). Idempotent by purchaseId.
  async addAiTokens (workspace: WorkspaceUuid, purchaseId: string, amount: number): Promise<{ applied: boolean }> {
    const path = `/api/v1/${workspace}/ai/tokens/add`
    const url = new URL(concatLink(this.endpoint, path))
    const body = JSON.stringify({ purchaseId, amount })
    const response = await fetchSafe(url, { method: 'POST', headers: { ...this.headers }, body })
    return (await response.json()) as { applied: boolean }
  }

  async getLargestSpaces (workspace: WorkspaceUuid): Promise<LargestSpaceInfo[]> {
    const path = `/api/v1/${workspace}/spaces/largest`
    const url = new URL(concatLink(this.endpoint, path))
    const response = await fetchSafe(url, { headers: { ...this.headers } })
    return (await response.json()) as LargestSpaceInfo[]
  }
}

async function fetchSafe (url: string | URL, init?: RequestInit): Promise<Response> {
  let response
  try {
    response = await fetch(url, init)
  } catch (err: unknown) {
    throw new NetworkError(`Network error: ${String(err)}`)
  }

  if (!response.ok) {
    const text = await response.text()
    // truncate body: may contain stack traces / internal paths
    console.error(`Billing request failed: ${response.status}`, text.slice(0, 200))
    throw new BillingError(`Billing request failed with status ${response.status}`)
  }

  return response
}
