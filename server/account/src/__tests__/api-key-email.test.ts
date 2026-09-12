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

import {
  AccountRole,
  type AccountUuid,
  type MeasureContext,
  type PersonUuid,
  type WorkspaceUuid
} from '@hcengineering/core'
import { getMetadata } from '@hcengineering/platform'
import { decodeTokenVerbose } from '@hcengineering/server-token'

import { createApiKey } from '../operations'
import { accountPlugin } from '../plugin'
import { type AccountDB } from '../types'

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    ...actual.default,
    getMetadata: jest.fn(),
    translate: jest.fn(async (id, params) => `${id} << ${JSON.stringify(params)}`)
  }
})

jest.mock('@hcengineering/server-token', () => ({
  decodeTokenVerbose: jest.fn()
}))

describe('createApiKey email notification', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const workspace = 'workspace-uuid' as WorkspaceUuid
  const owner = 'owner-uuid' as AccountUuid
  const mailSend = jest.fn()

  const mockDb = {
    workspace: { findOne: jest.fn().mockResolvedValue({ uuid: workspace, name: 'Test WS', url: 'test-ws' }) },
    getWorkspaceRole: jest.fn().mockResolvedValue(AccountRole.Owner),
    getWorkspaceMembers: jest.fn().mockResolvedValue([{ person: owner, role: AccountRole.Owner }]),
    socialId: {
      find: jest.fn().mockResolvedValue([{ value: 'owner@example.com', createdOn: 1, verifiedOn: 1 }]),
      insertOne: jest.fn().mockResolvedValue('huly-social-id'),
      update: jest.fn()
    },
    person: { findOne: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }) },
    ensurePerson: jest.fn().mockResolvedValue({ uuid: 'key-person-uuid' as PersonUuid, socialId: 'key-social-id' }),
    account: { insertOne: jest.fn() },
    accountEvent: { insertOne: jest.fn() },
    userProfile: { insertOne: jest.fn() },
    assignWorkspace: jest.fn(),
    integration: { insertOne: jest.fn() },
    integrationSecret: { find: jest.fn().mockResolvedValue([]), insertOne: jest.fn() }
  } as unknown as AccountDB

  beforeEach(() => {
    jest.clearAllMocks()
    mailSend.mockClear()
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ account: owner, workspace, extra: {} })
    ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: workspace, name: 'Test WS', url: 'test-ws' })
    ;(mockDb.getWorkspaceRole as jest.Mock).mockResolvedValue(AccountRole.Owner)
    ;(mockDb.getWorkspaceMembers as jest.Mock).mockResolvedValue([{ person: owner, role: AccountRole.Owner }])
    ;(mockDb.socialId.find as jest.Mock).mockResolvedValue([
      { value: 'owner@example.com', createdOn: 1, verifiedOn: 1 }
    ])
    ;(mockDb.person.findOne as jest.Mock).mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' })
    ;(getMetadata as jest.Mock).mockImplementation((key) =>
      key === accountPlugin.metadata.MailQueue ? { send: mailSend } : undefined
    )
  })

  test('sends the owner a notification without the raw key, only the masked one', async () => {
    const result = await createApiKey(mockCtx, mockDb, null, 'token', { name: 'ci', ops: ['issue:create'] })

    expect(mailSend).toHaveBeenCalledTimes(1)
    const sentTo = mailSend.mock.calls[0][3]
    const sentHtml: string = mailSend.mock.calls[0][2][0].data.html
    expect(sentTo).toBe('owner@example.com')
    expect(sentHtml).not.toContain(result.key)
    expect(sentHtml).toContain(result.info.masked)
  })

  test('a failed send is logged and does not throw or block key creation', async () => {
    mailSend.mockRejectedValue(new Error('smtp down'))

    const result = await createApiKey(mockCtx, mockDb, null, 'token', { name: 'ci', ops: [] })

    expect(result.key).toBeDefined()
    expect(mockDb.integrationSecret.insertOne).toHaveBeenCalled()
    expect(mockCtx.error).toHaveBeenCalledWith(
      'Failed to send API key created email',
      expect.objectContaining({ workspace })
    )
  })
})
