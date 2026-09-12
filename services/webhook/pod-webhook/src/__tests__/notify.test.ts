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

jest.mock('@hcengineering/account-client', () => ({ getClient: jest.fn() }))

/* eslint-disable import/first */
import { getClient } from '@hcengineering/account-client'
import { notifyOwnerDisabled } from '../notify'
/* eslint-enable import/first */

const mockAccountClient = getClient as jest.Mock

const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

function endpoint (): any {
  return { _id: 'ep_1', url: 'https://receiver.example/hook' }
}

const ws = 'ws_1' as any

describe('notifyOwnerDisabled', () => {
  test('mails every workspace owner', async () => {
    const getWorkspaceOwnerEmails = jest.fn().mockResolvedValue(['a@example.com', 'b@example.com'])
    mockAccountClient.mockReturnValue({ getWorkspaceOwnerEmails })
    const producer: any = { send: jest.fn().mockResolvedValue(undefined) }

    await notifyOwnerDisabled(newCtx(), 'http://account', 'tok', ws, producer, endpoint(), 'http 400')

    expect(getWorkspaceOwnerEmails).toHaveBeenCalledWith(ws)
    expect(producer.send).toHaveBeenCalledTimes(2)
    const [, , [msg], to] = producer.send.mock.calls[0]
    expect(msg.type).toBe('email')
    expect(msg.data.to).toBe('a@example.com')
    expect(to).toBe('a@example.com')
    expect(msg.data.text).toContain('https://receiver.example/hook')
    expect(msg.data.text).toContain('http 400')
    expect(producer.send.mock.calls[1][2][0].data.to).toBe('b@example.com')
  })

  test('logs a warning and sends nothing when the workspace has no owner email', async () => {
    mockAccountClient.mockReturnValue({ getWorkspaceOwnerEmails: jest.fn().mockResolvedValue([]) })
    const producer: any = { send: jest.fn() }
    const ctx = newCtx()

    await notifyOwnerDisabled(ctx, 'http://account', 'tok', ws, producer, endpoint(), 'http 400')

    expect(producer.send).not.toHaveBeenCalled()
    expect(ctx.warn).toHaveBeenCalled()
  })

  test('a producer failure is swallowed - a failed notification must not throw', async () => {
    mockAccountClient.mockReturnValue({ getWorkspaceOwnerEmails: jest.fn().mockResolvedValue(['owner@example.com']) })
    const producer: any = { send: jest.fn().mockRejectedValue(new Error('queue down')) }
    const ctx = newCtx()

    await expect(
      notifyOwnerDisabled(ctx, 'http://account', 'tok', ws, producer, endpoint(), 'http 400')
    ).resolves.toBeUndefined()
    expect(ctx.error).toHaveBeenCalled()
  })
})
