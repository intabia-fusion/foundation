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
  getWorkspaceInfo,
  getTransactorApiEndpoint,
  getNotificationUrl,
  getNotificationLocation,
  getDomain
} from '../workspace'
import { getAccountClient } from '@hcengineering/server-client'
import { getMetadata } from '@hcengineering/platform'
import { getNotificationMessageId, DocNotifyContext, ContextNotification } from '@hcengineering/notification'
import { Client } from '../../types'
import { Ref, Doc, Class } from '@hcengineering/core'

jest.mock('@hcengineering/server-client', () => ({
  getAccountClient: jest.fn()
}))

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    getMetadata: jest.fn()
  }
})

jest.mock('@hcengineering/notification', () => {
  const actual = jest.requireActual('@hcengineering/notification')
  return {
    ...actual,
    getNotificationMessageId: jest.fn()
  }
})

describe('workspace utils', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  describe('getWorkspaceInfo', () => {
    it('returns workspace info on success', async () => {
      const mockWorkspace = { endpoint: 'wss://test.endpoint' }
      const mockInfo = { isDisabled: false, mode: 'active', name: 'Test WS' }
      const mockClient = {
        selectWorkspace: jest.fn().mockResolvedValue(mockWorkspace),
        getWorkspaceInfo: jest.fn().mockResolvedValue(mockInfo)
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      const result = await getWorkspaceInfo('mock-token')
      expect(getAccountClient).toHaveBeenCalledWith('mock-token', 30000)
      expect(mockClient.selectWorkspace).toHaveBeenCalledWith('', 'internal', [])
      expect(mockClient.getWorkspaceInfo).toHaveBeenCalledWith(false)
      expect(result).toEqual({
        isDisabled: false,
        mode: 'active',
        name: 'Test WS',
        endpoint: 'wss://test.endpoint'
      })
    })

    it('returns undefined if workspace is disabled', async () => {
      const mockWorkspace = { endpoint: 'wss://test.endpoint' }
      const mockInfo = { isDisabled: true, mode: 'active' }
      const mockClient = {
        selectWorkspace: jest.fn().mockResolvedValue(mockWorkspace),
        getWorkspaceInfo: jest.fn().mockResolvedValue(mockInfo)
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      const result = await getWorkspaceInfo('mock-token')
      expect(result).toBeUndefined()
    })

    it('returns undefined if mode is not active', async () => {
      const mockWorkspace = { endpoint: 'wss://test.endpoint' }
      const mockInfo = { isDisabled: false, mode: 'archived' }
      const mockClient = {
        selectWorkspace: jest.fn().mockResolvedValue(mockWorkspace),
        getWorkspaceInfo: jest.fn().mockResolvedValue(mockInfo)
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      const result = await getWorkspaceInfo('mock-token')
      expect(result).toBeUndefined()
    })

    it('throws if workspace is not found', async () => {
      const mockClient = {
        selectWorkspace: jest.fn().mockResolvedValue(undefined),
        getWorkspaceInfo: jest.fn()
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      await expect(getWorkspaceInfo('mock-token')).rejects.toThrow('Workspace not found')
    })

    it('retries on retryable errors and succeeds afterwards', async () => {
      jest.useFakeTimers()
      const retryableError = new Error('Connection reset')
      ;(retryableError as any).cause = { code: 'ECONNRESET' }

      const mockWorkspace = { endpoint: 'wss://test.endpoint' }
      const mockInfo = { isDisabled: false, mode: 'active' }

      const selectWorkspaceMock = jest.fn().mockRejectedValueOnce(retryableError).mockResolvedValueOnce(mockWorkspace)

      const mockClient = {
        selectWorkspace: selectWorkspaceMock,
        getWorkspaceInfo: jest.fn().mockResolvedValue(mockInfo)
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      const promise = getWorkspaceInfo('mock-token')

      // Resolve the timer to allow next retry
      await Promise.resolve() // let rejection propagate
      jest.advanceTimersByTime(1000)

      const result = await promise
      expect(selectWorkspaceMock).toHaveBeenCalledTimes(2)
      expect(result).toEqual({
        isDisabled: false,
        mode: 'active',
        endpoint: 'wss://test.endpoint'
      })
    })

    it('throws immediately on non-retryable error', async () => {
      const generalError = new Error('Internal Server Error')
      const mockClient = {
        selectWorkspace: jest.fn().mockRejectedValue(generalError),
        getWorkspaceInfo: jest.fn()
      }
      ;(getAccountClient as jest.Mock).mockReturnValue(mockClient)

      await expect(getWorkspaceInfo('mock-token')).rejects.toThrow('Internal Server Error')
    })
  })

  describe('getTransactorApiEndpoint', () => {
    it('converts wss protocol to https', () => {
      expect(getTransactorApiEndpoint({ endpoint: 'wss://foo.bar/ws' })).toBe('https://foo.bar/ws')
    })

    it('converts ws protocol to http', () => {
      expect(getTransactorApiEndpoint({ endpoint: 'ws://localhost:8080' })).toBe('http://localhost:8080')
    })

    it('leaves http/https unchanged', () => {
      expect(getTransactorApiEndpoint({ endpoint: 'https://hello.world' })).toBe('https://hello.world')
    })
  })

  describe('getNotificationLocation', () => {
    it('generates path and query with message parameter', () => {
      const client = { workspace: { url: 'my-workspace-url' } } as unknown as Client
      ;(getNotificationMessageId as jest.Mock).mockReturnValue('message-123')

      const location = getNotificationLocation(
        client,
        'context-1' as Ref<DocNotifyContext>,
        { type: 'message' } as unknown as ContextNotification,
        'doc-1' as Ref<Doc>,
        'class-1' as Ref<Class<Doc>>
      )

      expect(location.path).toEqual(['workbench', 'my-workspace-url', 'notification', 'doc-1%7Cclass-1'])
      expect(location.query).toEqual({ message: 'message-123', context: 'context-1' })
    })

    it('generates path and query without message parameter when messageId is null', () => {
      const client = { workspace: { url: 'my-workspace-url' } } as unknown as Client
      ;(getNotificationMessageId as jest.Mock).mockReturnValue(null)

      const location = getNotificationLocation(
        client,
        'context-1' as Ref<DocNotifyContext>,
        { type: 'common' } as unknown as ContextNotification,
        'doc-1' as Ref<Doc>,
        'class-1' as Ref<Class<Doc>>
      )

      expect(location.path).toEqual(['workbench', 'my-workspace-url', 'notification', 'doc-1%7Cclass-1'])
      expect(location.query).toEqual({ context: 'context-1' })
    })
  })

  describe('getNotificationUrl', () => {
    it('uses branding front url if present', () => {
      const client = {
        branding: { front: 'https://branded-front.com/' },
        workspace: { url: 'my-workspace-url' }
      } as unknown as Client
      ;(getNotificationMessageId as jest.Mock).mockReturnValue(null)

      const url = getNotificationUrl(
        client,
        'context-1' as Ref<DocNotifyContext>,
        { type: 'common' } as unknown as ContextNotification,
        'doc-1' as Ref<Doc>,
        'class-1' as Ref<Class<Doc>>
      )

      expect(url).toBe(
        'https://branded-front.com/workbench/my-workspace-url/notification/doc-1%7Cclass-1?context=context-1'
      )
    })

    it('falls back to metadata FrontUrl if branding is missing', () => {
      const client = {
        workspace: { url: 'my-workspace-url' }
      } as unknown as Client
      ;(getMetadata as jest.Mock).mockReturnValue('https://default-front.com')
      ;(getNotificationMessageId as jest.Mock).mockReturnValue('msg-999')

      const url = getNotificationUrl(
        client,
        'context-1' as Ref<DocNotifyContext>,
        { type: 'message' } as unknown as ContextNotification,
        'doc-1' as Ref<Doc>,
        'class-1' as Ref<Class<Doc>>
      )

      expect(url).toBe(
        'https://default-front.com/workbench/my-workspace-url/notification/doc-1%7Cclass-1?message=msg-999&context=context-1'
      )
    })
  })

  describe('getDomain', () => {
    it('generates domain URL utilizing branding or metadata', () => {
      const client = {
        branding: { front: 'https://branded.com' },
        workspace: { url: 'sub-url' }
      } as unknown as Client

      expect(getDomain(client)).toBe('https://branded.com/workbench/sub-url')
    })
  })
})
