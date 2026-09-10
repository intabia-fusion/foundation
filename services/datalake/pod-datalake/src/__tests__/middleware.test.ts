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

import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import { extractToken, readToken } from '@hcengineering/server-client'
import { withAuthorization, withWorkspace, RequestWithAuth } from '../middleware'
import { Response, NextFunction } from 'express'

// Mock the ApiError
jest.mock('../error', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor (status: number, message: string) {
      super(message)
      this.status = status
    }
  }
}))

describe('middleware', () => {
  const accountUuid = '85da8aa0-7334-41bc-b69f-5f05ce88483c' as PersonUuid
  const workspaceUuid = '71ac4d19-6dff-49e4-9618-259d0321a2a3' as WorkspaceUuid

  describe('extractToken with multiple cookies', () => {
    it('should prefer token with workspace over token without workspace', () => {
      // Create token without workspace (account token)
      const accountToken = generateToken(accountUuid, undefined, { authMethod: 'otp' })

      // Create token with workspace (presentation token)
      const workspaceToken = generateToken(accountUuid, workspaceUuid, { authMethod: 'otp' })

      // Simulate cookie header with both tokens
      const headers = {
        cookie: `account-metadata-Token=${accountToken}; presentation-metadata-Token=${workspaceToken}`
      }

      const result = extractToken(headers)

      // Should return token with workspace
      expect(result).toBeDefined()
      expect(result?.account).toBe(accountUuid)
      expect(result?.workspace).toBe(workspaceUuid)
    })

    it('should fallback to token without workspace if no workspace token present', () => {
      // Create token without workspace
      const accountToken = generateToken(accountUuid, undefined, { authMethod: 'otp' })

      const headers = {
        cookie: `account-metadata-Token=${accountToken}`
      }

      const result = extractToken(headers)

      expect(result).toBeDefined()
      expect(result?.account).toBe(accountUuid)
      expect(result?.workspace).toBeUndefined()
    })

    it('should return undefined for invalid tokens', () => {
      const headers = {
        cookie: 'some-other-cookie=value; invalid-token=invalid.value.here'
      }

      const result = extractToken(headers)

      expect(result).toBeUndefined()
    })

    it('should handle Authorization header first', () => {
      const authToken = generateToken(accountUuid, workspaceUuid, {})
      const cookieToken = generateToken(accountUuid, undefined, {})

      const headers = {
        authorization: `Bearer ${authToken}`,
        cookie: `token=${cookieToken}`
      }

      const result = extractToken(headers)

      // Should prefer Authorization header
      expect(result?.workspace).toBe(workspaceUuid)
    })
  })

  describe('readToken with multiple cookies', () => {
    it('should return first token from cookies without decoding or validation', () => {
      // readToken simply returns the first matching cookie value without decoding
      const firstToken = 'any-string-token-1'
      const secondToken = 'any-string-token-2'

      // Simulate cookie header with both tokens - first one should be returned
      const headers = {
        cookie: `first-token=${firstToken}; second-token=${secondToken}`
      }

      const result = readToken(headers)

      // Should return first token (no decoding, no workspace preference)
      expect(result).toBe(firstToken)
    })

    it('should return token string from cookie', () => {
      const tokenValue = 'my-api-key-or-token'

      const headers = {
        cookie: `my-token=${tokenValue}`
      }

      const result = readToken(headers)

      expect(result).toBe(tokenValue)
    })

    it('should return undefined when no token cookies present', () => {
      const headers = {
        cookie: 'session=abc123; user=john'
      }

      const result = readToken(headers)

      expect(result).toBeUndefined()
    })
  })

  describe('withAuthorization and withWorkspace', () => {
    let req: Partial<RequestWithAuth>
    let res: Partial<Response>
    let next: NextFunction

    beforeEach(() => {
      req = {
        params: {},
        headers: {}
      }
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }
      next = jest.fn()
    })

    it('should authorize with correct workspace token from cookies', () => {
      const workspaceToken = generateToken(accountUuid, workspaceUuid, {})

      req.headers = {
        cookie: `account-metadata-Token=${generateToken(accountUuid, undefined, {})}; presentation-metadata-Token=${workspaceToken}`
      }
      req.params = { workspace: workspaceUuid }

      // First call withAuthorization
      withAuthorization(req as RequestWithAuth, res as Response, () => {
        // Then call withWorkspace
        withWorkspace(req as RequestWithAuth, res as Response, next)
      })

      // Should have token with workspace
      expect(req.token).toBeDefined()
      expect(req.token?.workspace).toBe(workspaceUuid)
      expect(next).toHaveBeenCalled()
    })
  })
})
