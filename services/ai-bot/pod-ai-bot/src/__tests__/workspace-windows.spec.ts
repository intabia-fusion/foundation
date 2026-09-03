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

jest.mock('../config', () => ({ __esModule: true, default: { BillingUrl: 'http://billing.local' } }))

const getWorkspaceTokenWindows = jest.fn()
jest.mock('@hcengineering/billing-client', () => ({
  __esModule: true,
  getClient: () => ({ getWorkspaceTokenWindows })
}))

/* eslint-disable import/first */
import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { v4 as uuid } from 'uuid'
import config from '../config'
import { getWorkspaceWindows } from '../billing'
/* eslint-enable import/first */

function mockCtx (): MeasureContext {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
}

describe('getWorkspaceWindows', () => {
  afterEach(() => {
    jest.clearAllMocks()
    ;(config as any).BillingUrl = 'http://billing.local'
    jest.useRealTimers()
  })

  it('billing not configured -> unmetered, no fetch', async () => {
    ;(config as any).BillingUrl = ''
    const w = await getWorkspaceWindows(mockCtx(), 'ws-unconfigured' as WorkspaceUuid)
    expect(w).toEqual({ month: { used: 0, limit: 0 }, balance: 0, plan: 'unknown', isFree: false, hasPackages: false })
    expect(getWorkspaceTokenWindows).not.toHaveBeenCalled()
  })

  it('propagates balance from the billing response', async () => {
    const wsId = uuid() as WorkspaceUuid
    getWorkspaceTokenWindows.mockResolvedValue({
      workspace: wsId,
      plan: 'business',
      isFree: false,
      basicLevelLabel: 'Low',
      hasPackages: true,
      month: { used: 10, limit: 100, windowHours: 720, resetAt: null, levels: [] },
      balance: 4242,
      available: null
    })

    const w = await getWorkspaceWindows(mockCtx(), wsId)
    expect(w.balance).toBe(4242)
    expect(w.plan).toBe('business')
    expect(w.hasPackages).toBe(true)
    expect(w.month).toEqual({ used: 10, limit: 100 })
  })

  it('billing unreachable, no cache -> unavailable with balance 0', async () => {
    getWorkspaceTokenWindows.mockRejectedValue(new Error('boom'))
    const w = await getWorkspaceWindows(mockCtx(), uuid() as WorkspaceUuid)
    expect(w).toEqual({
      month: { used: 0, limit: 0 },
      balance: 0,
      plan: 'unknown',
      isFree: false,
      hasPackages: false,
      unavailable: true
    })
  })

  it('billing unreachable, stale cache present -> serves the cached value, not unavailable', async () => {
    jest.useFakeTimers()
    const wsId = uuid() as WorkspaceUuid

    getWorkspaceTokenWindows.mockResolvedValueOnce({
      workspace: wsId,
      plan: 'free',
      isFree: true,
      basicLevelLabel: 'Low',
      hasPackages: false,
      month: { used: 5, limit: 50, windowHours: 720, resetAt: null, levels: [] },
      balance: 100,
      available: 45
    })
    const first = await getWorkspaceWindows(mockCtx(), wsId)
    expect(first.balance).toBe(100)

    // Past the 30s cache TTL, so the next call actually re-fetches (and fails) instead of
    // short-circuiting on the fresh-cache path.
    jest.advanceTimersByTime(31_000)
    getWorkspaceTokenWindows.mockRejectedValueOnce(new Error('boom'))

    const second = await getWorkspaceWindows(mockCtx(), wsId)
    expect(second).toEqual(first)
    expect(second.unavailable).toBeUndefined()
  })
})
