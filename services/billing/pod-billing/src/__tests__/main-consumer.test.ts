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
import { type WorkspaceUuid } from '@hcengineering/core'
import { BillingMessageKind } from '../types'

const consumers: Record<string, any> = {}
const dbMock = {
  pushAiTokensData: jest.fn(async () => {}),
  replaceAiModelRegistry: jest.fn(async () => {})
}

jest.mock('@hcengineering/analytics', () => ({ Analytics: { setTag: jest.fn() } }))
jest.mock('@hcengineering/analytics-service', () => ({
  configureAnalytics: jest.fn(),
  createOpenTelemetryMetricsContext: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    with: jest.fn()
  })),
  SplitLogger: jest.fn()
}))
jest.mock('@hcengineering/kafka', () => ({
  getPlatformQueue: jest.fn(() => ({
    getProducer: jest.fn(() => ({ send: jest.fn(), close: jest.fn() })),
    createBatchConsumer: jest.fn((_ctx: any, topic: any, _group: any, handler: any) => {
      consumers[topic] = handler
      return { close: jest.fn() }
    })
  }))
}))
// @hcengineering/core's `plugin()` helper comes from this module too - keep the real module,
// only stub setMetadata to avoid touching the real metadata registry.
jest.mock('@hcengineering/platform', () => ({
  ...jest.requireActual('@hcengineering/platform'),
  setMetadata: jest.fn()
}))
jest.mock('@hcengineering/server-client', () => ({ __esModule: true, default: { metadata: { Endpoint: 'endpoint' } } }))
jest.mock('@hcengineering/server-token', () => ({
  __esModule: true,
  default: { metadata: { Secret: 'secret', Service: 'service' } },
  generateToken: jest.fn(() => 'tok')
}))
jest.mock('@hcengineering/server-storage', () => ({
  storageConfigFromEnv: jest.fn(() => ({ default: '', storages: [] }))
}))
jest.mock('../config', () => ({
  __esModule: true,
  default: {
    Port: 4040,
    Secret: 's',
    AccountsUrl: 'http://a',
    DbUrl: 'db',
    StorageConfig: '',
    UsageUpdateInterval: 60,
    AdminEmails: [],
    QueueRegion: '',
    WindowMonthLimit: 100,
    ProviderPrices: {}
  }
}))
jest.mock('../db/postgres', () => ({ createDb: jest.fn(async () => dbMock) }))
jest.mock('../limits', () => ({
  LimitsEngine: jest.fn().mockImplementation(() => ({
    recomputeWorkspace: jest.fn(async () => {}),
    startupScan: jest.fn(async () => {}),
    processUsageBatch: jest.fn(async () => {})
  }))
}))
jest.mock('../notify', () => ({ createPoolNotifier: jest.fn(() => jest.fn()) }))
jest.mock('../server', () => ({
  createServer: jest.fn(async () => ({ app: {}, close: jest.fn() })),
  listen: jest.fn(() => ({ close: jest.fn() }))
}))
jest.mock('../usage', () => ({
  UsageWorker: jest.fn().mockImplementation(() => ({
    schedule: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    recomputeWorkspacesNow: jest.fn(async () => {})
  }))
}))

const WS = '123e4567-e89b-12d3-a456-426614174000' as WorkspaceUuid
const ctx: any = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
const queueControl: any = { heartbeat: jest.fn(async () => {}) }

describe('main billing-usage consumer', () => {
  let handler: any

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { main } = require('../main')
    await main()
    handler = consumers['billing-usage']
  })

  beforeEach(() => {
    dbMock.pushAiTokensData.mockClear()
    dbMock.replaceAiModelRegistry.mockClear()
  })

  it('registered the billing-usage consumer', () => {
    expect(handler).toBeInstanceOf(Function)
  })

  it('pushes AiTokensDetail data to db on a valid array', async () => {
    const data = [{ workspace: WS, reason: 'chat', tokens: 10, date: '2026-01-01' }]
    await handler(ctx, [{ workspace: WS, value: { kind: BillingMessageKind.AiTokensDetail, data } }], queueControl)
    expect(dbMock.pushAiTokensData).toHaveBeenCalledWith(ctx, data)
  })

  it('does not throw and does not call db on an invalid AiTokensDetail (data not an array)', async () => {
    await handler(
      ctx,
      [{ workspace: WS, value: { kind: BillingMessageKind.AiTokensDetail, data: 'not-an-array' } }],
      queueControl
    )
    expect(dbMock.pushAiTokensData).not.toHaveBeenCalled()
  })

  it('replaces the AI model registry on a valid AiRegistry message', async () => {
    const entries = [{ providerId: 'p', model: 'm', level: 'low', label: 'Basic' }]
    await handler(ctx, [{ workspace: WS, value: { kind: BillingMessageKind.AiRegistry, entries } }], queueControl)
    expect(dbMock.replaceAiModelRegistry).toHaveBeenCalledWith(ctx, entries)
  })

  it('does not throw and does not call db on an invalid AiRegistry (entries not an array)', async () => {
    await handler(ctx, [{ workspace: WS, value: { kind: BillingMessageKind.AiRegistry, entries: {} } }], queueControl)
    expect(dbMock.replaceAiModelRegistry).not.toHaveBeenCalled()
  })
})
