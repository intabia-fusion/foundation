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

// Stub config (no env-validating IIFE) and the billing REST client, so we can assert
// pushTokensData never touches it anymore (detail moved to the queue).
jest.mock('../config', () => ({ __esModule: true, default: {} }))

const postAiTokensData = jest.fn()
const getBillingClient = jest.fn((url?: string, token?: string) => ({ postAiTokensData }))
jest.mock('@hcengineering/billing-client', () => ({
  __esModule: true,
  getClient: (url?: string, token?: string) => getBillingClient(url, token)
}))

/* eslint-disable import/first */
import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { BillingMessageKind, pushTokensData, setUsageProducer, tokensRecord } from '../billing'
/* eslint-enable import/first */

const ws = 'ws-push' as WorkspaceUuid

function mockCtx (): MeasureContext {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
}

describe('pushTokensData', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('sends the aggregated delta and the per-model detail in a single call on the workspace key', async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    setUsageProducer({ send } as any)

    const data = [tokensRecord(ws, 100, 0, 1, 'chat', 'model-a'), tokensRecord(ws, 50, 0, 1, 'chat', 'model-b')]

    await pushTokensData(mockCtx(), data)

    expect(send).toHaveBeenCalledTimes(1)
    const [, key, messages] = send.mock.calls[0]
    expect(key).toBe(ws) // same partition key for both messages

    const usageMsg = messages.find((m: any) => m.kind === BillingMessageKind.Usage)
    const detailMsg = messages.find((m: any) => m.kind === BillingMessageKind.AiTokensDetail)

    expect(usageMsg).toMatchObject({ kind: BillingMessageKind.Usage, workspace: ws, metric: 'tokens', amount: 150 })
    expect(typeof usageMsg.ref).toBe('string')
    expect(detailMsg).toEqual({ kind: BillingMessageKind.AiTokensDetail, data })
  })

  it('delta is ordered before the detail message (delta cannot be outrun)', async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    setUsageProducer({ send } as any)

    await pushTokensData(mockCtx(), [tokensRecord(ws, 10, 0, 1, 'chat')])

    const messages = send.mock.calls[0][2]
    expect(messages[0].kind).toBe(BillingMessageKind.Usage)
    expect(messages[1].kind).toBe(BillingMessageKind.AiTokensDetail)
  })

  it('zero total tokens: no delta message, detail still sent', async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    setUsageProducer({ send } as any)

    const zero = tokensRecord(ws, 0, 0, 1, 'chat')
    await pushTokensData(mockCtx(), [zero])

    const messages = send.mock.calls[0][2]
    expect(messages).toEqual([{ kind: BillingMessageKind.AiTokensDetail, data: [zero] }])
  })

  it('never calls the billing REST client (detail goes through the queue only)', async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    setUsageProducer({ send } as any)

    await pushTokensData(mockCtx(), [tokensRecord(ws, 10, 0, 1, 'chat')])

    expect(getBillingClient).not.toHaveBeenCalled()
    expect(postAiTokensData).not.toHaveBeenCalled()
  })
})
