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

import { buildContext } from '../context'
import * as platformModule from '../platform'
import type { WorkspaceIds } from '@hcengineering/core'

jest.mock('@hcengineering/server-token', () => ({
  decodeToken: jest.fn()
}))

jest.mock('../platform', () => ({
  simpleClientFactory: jest.fn()
}))

const mockDecodeToken = jest.requireMock('@hcengineering/server-token').decodeToken
const mockSimpleClientFactory = platformModule.simpleClientFactory as jest.MockedFunction<
  typeof platformModule.simpleClientFactory
>

describe('context', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('buildContext', () => {
    const mockWorkspaceIds: WorkspaceIds = {
      uuid: 'workspace-uuid' as any,
      dataId: 'workspace-data-id' as any,
      url: 'workspace-url'
    }

    const createMockPayload = (overrides = {}): any => ({
      token: 'test-token',
      documentName: 'test-doc',
      requestParameters: new Map(),
      context: {},
      ...overrides
    })

    it('should build context with all required fields', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: {}
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const payload = createMockPayload()
      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.connectionId).toBeDefined()
      expect(result.wsIds).toBe(mockWorkspaceIds)
      expect(result.clientFactory).toBe(mockClientFactory)
      expect(result.content).toBeUndefined()
    })

    it('should use existing connectionId from context if provided', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: {}
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const existingConnectionId = 'existing-connection-id'
      const payload = createMockPayload({
        context: { connectionId: existingConnectionId }
      })

      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.connectionId).toBe(existingConnectionId)
    })

    it('should generate new connectionId if not provided', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: {}
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const payload = createMockPayload({ context: {} })
      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.connectionId).toBeDefined()
      expect(typeof result.connectionId).toBe('string')
      expect(result.connectionId.length).toBeGreaterThan(0)
    })

    it('should extract content from request parameters', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: {}
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const requestParams = new Map([['content', 'blob-reference-id']])
      const payload = createMockPayload({ requestParameters: requestParams })

      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.content).toBe('blob-reference-id')
    })

    it('should handle undefined content in request parameters', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: {}
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const payload = createMockPayload()
      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.content).toBeUndefined()
    })

    it('should decode token to create client factory', () => {
      const mockToken = {
        account: 'account-uuid',
        workspace: 'workspace-uuid',
        extra: { service: 'collaborator' }
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const payload = createMockPayload({ token: 'custom-token' })
      buildContext(payload, mockWorkspaceIds)

      expect(mockDecodeToken).toHaveBeenCalledWith('custom-token')
      expect(mockSimpleClientFactory).toHaveBeenCalledWith(mockToken)
    })

    it('should handle token with system account', () => {
      const mockToken = {
        account: 'system',
        workspace: 'workspace-uuid',
        extra: { service: 'collaborator', admin: 'true' }
      }
      mockDecodeToken.mockReturnValue(mockToken)

      const mockClientFactory = jest.fn()
      mockSimpleClientFactory.mockReturnValue(mockClientFactory)

      const payload = createMockPayload()
      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.connectionId).toBeDefined()
      expect(mockSimpleClientFactory).toHaveBeenCalledWith(mockToken)
    })

    it('should extract silent parameter from requestParameters into meta', () => {
      const mockToken = { account: 'account-uuid', workspace: 'workspace-uuid', extra: {} }
      mockDecodeToken.mockReturnValue(mockToken)

      const requestParams = new Map([['silent', 'true']])
      const payload = createMockPayload({ requestParameters: requestParams })

      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.meta?.silent).toBe(true)
    })

    it('should extract silent parameter from context meta if not in requestParameters', () => {
      const mockToken = { account: 'account-uuid', workspace: 'workspace-uuid', extra: {} }
      mockDecodeToken.mockReturnValue(mockToken)

      const payload = createMockPayload({ context: { meta: { silent: true } } })

      const result = buildContext(payload, mockWorkspaceIds)

      expect(result.meta?.silent).toBe(true)
    })
  })
})
