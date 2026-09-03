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

jest.mock('../config', () => ({
  __esModule: true,
  default: { BillingUrl: 'http://billing.local', AccountsURL: 'http://accounts.local' }
}))

const addAiTokens = jest.fn()
jest.mock('@hcengineering/billing-client', () => ({
  __esModule: true,
  getClient: () => ({ addAiTokens })
}))

const updatePurchaseStatus = jest.fn()
jest.mock('@hcengineering/account-client', () => ({
  __esModule: true,
  getClient: () => ({ updatePurchaseStatus })
}))

/* eslint-disable import/first */
import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { v4 as uuid } from 'uuid'
import { applyPurchase } from '../billing'
/* eslint-enable import/first */

// generateToken validates the workspace as a real UUID.
const ws = uuid() as WorkspaceUuid

function mockCtx (): MeasureContext {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
}

describe('applyPurchase', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('ignores an effect it does not own', async () => {
    await applyPurchase(mockCtx(), ws, 'p1', 'some-other-effect', 10)
    expect(addAiTokens).not.toHaveBeenCalled()
  })

  it.each([undefined, 0, -5])('quantity %p: logs and does not call billing', async (quantity) => {
    const ctx = mockCtx()
    await applyPurchase(ctx, ws, 'p1', 'add-ai-tokens', quantity)
    expect(addAiTokens).not.toHaveBeenCalled()
    expect(ctx.error).toHaveBeenCalled()
  })

  it('grants tokens via billingClient.addAiTokens', async () => {
    addAiTokens.mockResolvedValue({ applied: true })
    updatePurchaseStatus.mockResolvedValue(undefined)

    await applyPurchase(mockCtx(), ws, 'p1', 'add-ai-tokens', 500)

    expect(addAiTokens).toHaveBeenCalledWith(ws, 'p1', 500)
  })

  it('applied=true marks the purchase consumed in account', async () => {
    addAiTokens.mockResolvedValue({ applied: true })
    updatePurchaseStatus.mockResolvedValue(undefined)

    await applyPurchase(mockCtx(), ws, 'p1', 'add-ai-tokens', 500)

    expect(updatePurchaseStatus).toHaveBeenCalledWith('p1', 'consumed')
  })

  it('applied=false does not touch account at all', async () => {
    addAiTokens.mockResolvedValue({ applied: false })

    await applyPurchase(mockCtx(), ws, 'p1', 'add-ai-tokens', 500)

    expect(updatePurchaseStatus).not.toHaveBeenCalled()
  })

  it('consumed-marking failure is swallowed, not thrown (tokens already granted)', async () => {
    addAiTokens.mockResolvedValue({ applied: true })
    // Non-network error -> withRetry's isRetryable rejects immediately, no retry delay.
    updatePurchaseStatus.mockRejectedValue(new Error('consume failed'))
    const ctx = mockCtx()

    await expect(applyPurchase(ctx, ws, 'p1', 'add-ai-tokens', 500)).resolves.toBeUndefined()
    expect(ctx.warn).toHaveBeenCalled()
  })
})
