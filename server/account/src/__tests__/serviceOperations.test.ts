//
// Copyright © 2025 Hardcore Engineering Inc.
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
  type AccountUuid,
  AccountRole,
  type IntegrationKind,
  type MeasureContext,
  type PersonId,
  type PersonUuid,
  SocialIdType,
  type WorkspaceUuid
} from '@hcengineering/core'
import platform, { PlatformError, Status, Severity, getMetadata } from '@hcengineering/platform'
import { decodeTokenVerbose } from '@hcengineering/server-token'
import { workspaceEvents, LimitCategory, LimitStatus, QueueWorkspaceEvent } from '@hcengineering/server-core'

import {
  type AccountDB,
  type Integration,
  type IntegrationKey,
  type IntegrationSecret,
  type IntegrationSecretKey,
  SubscriptionStatus,
  SubscriptionType
} from '../types'
import * as utils from '../utils'
import {
  addSocialIdToPerson,
  createIntegration,
  deleteIntegration,
  deleteIntegrationSecret,
  getIntegration,
  getIntegrationSecret,
  listIntegrations,
  listIntegrationsSecrets,
  updateIntegration,
  updateIntegrationSecret,
  addIntegrationSecret,
  upsertSubscription,
  adminCreateSubscription,
  adminUpdateSubscription,
  getPersonInfo,
  updateWorkspaceInfo
} from '../serviceOperations'

// Mock platform
jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    ...actual.default,
    getMetadata: jest.fn(),
    translate: jest.fn((id, params) => `${id} << ${JSON.stringify(params)}`)
  }
})

// Mock server-token
jest.mock('@hcengineering/server-token', () => ({
  isHumanAdmin: jest.requireActual('@hcengineering/server-token').isHumanAdmin,
  hasAdminSession: jest.requireActual('@hcengineering/server-token').hasAdminSession,
  ADMIN_SESSION_TTL_SEC: jest.requireActual('@hcengineering/server-token').ADMIN_SESSION_TTL_SEC,
  decodeTokenVerbose: jest.fn(),
  generateToken: jest.fn()
}))

describe('addSocialIdToPerson', () => {
  const mockCtx = {
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {} as unknown as AccountDB
  const mockBranding = null
  const mockToken = 'test-token'

  // Create spy only for this test suite
  const addSocialIdSpy = jest.spyOn(utils, 'addSocialIdBase')

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    // Restore the original implementation
    addSocialIdSpy.mockRestore()
  })

  test('should allow github service to add social id', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'github' }
    })
    const newSocialId = 'new-social-id' as PersonId
    addSocialIdSpy.mockResolvedValue(newSocialId)

    const params = {
      person: 'test-person' as PersonUuid,
      type: SocialIdType.GITHUB,
      value: 'test-value',
      confirmed: true,
      displayValue: 'test-display-value'
    }

    const result = await addSocialIdToPerson(mockCtx, mockDb, mockBranding, mockToken, params)

    expect(result).toBe(newSocialId)
    expect(addSocialIdSpy).toHaveBeenCalledWith(
      mockDb,
      params.person,
      params.type,
      params.value,
      params.confirmed,
      params.displayValue
    )
  })

  test('should refuse an admin token: attaching an identity is a service action', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { admin: 'true' }
    })

    const params = {
      person: 'test-person' as PersonUuid,
      type: SocialIdType.GITHUB,
      value: 'test-value',
      confirmed: false,
      displayValue: 'test-display-value'
    }

    await expect(addSocialIdToPerson(mockCtx, mockDb, mockBranding, mockToken, params)).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )
    expect(addSocialIdSpy).not.toHaveBeenCalled()
  })

  test('should throw error for unauthorized service', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'other-service' }
    })

    const params = {
      person: 'test-person' as PersonUuid,
      type: SocialIdType.GITHUB,
      value: 'test-value',
      confirmed: false
    }

    await expect(addSocialIdToPerson(mockCtx, mockDb, mockBranding, mockToken, params)).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )

    expect(addSocialIdSpy).not.toHaveBeenCalled()
  })

  test('should throw error for regular user', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      account: 'test-account',
      workspace: 'test-workspace',
      extra: {}
    })

    const params = {
      person: 'test-person' as PersonUuid,
      type: SocialIdType.GITHUB,
      value: 'test-value',
      confirmed: false
    }

    await expect(addSocialIdToPerson(mockCtx, mockDb, mockBranding, mockToken, params)).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )

    expect(addSocialIdSpy).not.toHaveBeenCalled()
  })
})

describe('integration methods', () => {
  const mockCtx = {
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    workspace: {
      findOne: jest.fn()
    },
    socialId: {
      findOne: jest.fn(),
      find: jest.fn()
    },
    integration: {
      findOne: jest.fn(),
      insertOne: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      find: jest.fn()
    },
    integrationSecret: {
      findOne: jest.fn(),
      insertOne: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      find: jest.fn()
    }
  } as unknown as AccountDB

  const mockBranding = null
  const mockToken = 'test-token'

  const integrationServices = ['github', 'telegram-bot', 'hulygram', 'mailbox']

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createIntegration', () => {
    test('should allow allowed services to create integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockIntegration: Integration = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
      expect(mockDb.integration.insertOne).toHaveBeenCalledWith(mockIntegration)
    })

    test('should allow verified user to create their integration', async () => {
      const mockAccount = 'test-account'
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockIntegration: Integration = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
      expect(mockDb.integration.insertOne).toHaveBeenCalledWith(mockIntegration)
    })

    test('should throw error when user creates integration for different social id', async () => {
      const mockAccount = 'test-account'
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockIntegration: Integration = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await expect(createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
      expect(mockDb.integration.insertOne).not.toHaveBeenCalled()
    })

    test('should throw error when social id not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockIntegration: Integration = {
        socialId: 'nonexistent-social-id' as PersonId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)

      await expect(createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(
          new Status(Severity.ERROR, platform.status.SocialIdNotFound, { _id: 'nonexistent-social-id' })
        )
      )

      expect(mockDb.integration.insertOne).not.toHaveBeenCalled()
    })

    test('should throw error when workspace not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockIntegration: Integration = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'nonexistent-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue(null)

      await expect(createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(
          new Status(Severity.ERROR, platform.status.WorkspaceNotFound, { workspaceUuid: 'nonexistent-workspace' })
        )
      )

      expect(mockDb.integration.insertOne).not.toHaveBeenCalled()
    })

    test('should throw error when integration already exists', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockIntegration: Integration = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)

      await expect(createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationAlreadyExists, {}))
      )

      expect(mockDb.integration.insertOne).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      const mockIntegration: Integration = {
        socialId: 'test-social-id' as PersonId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        data: {}
      }

      await expect(createIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.insertOne).not.toHaveBeenCalled()
    })
  })

  describe('updateIntegration', () => {
    const mockAccount = 'test-account'
    const mockSocialId = 'test-social-id' as PersonId
    const mockIntegration: Integration = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      data: { someData: 'value' }
    }

    test('should allow allowed service to update integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegration,
        data: { oldData: 'old' }
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await updateIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)

      expect(mockDb.integration.update).toHaveBeenCalledWith(
        {
          socialId: mockIntegration.socialId,
          kind: mockIntegration.kind,
          workspaceUuid: mockIntegration.workspaceUuid
        },
        { data: mockIntegration.data }
      )

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
    })

    test('should allow verified user to update their integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegration,
        data: { oldData: 'old' }
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await updateIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)

      expect(mockDb.integration.update).toHaveBeenCalledWith(
        {
          socialId: mockIntegration.socialId,
          kind: mockIntegration.kind,
          workspaceUuid: mockIntegration.workspaceUuid
        },
        { data: mockIntegration.data }
      )

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when use updates integration for different social id', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegration,
        data: { oldData: 'old' }
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)

      await expect(updateIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.update).not.toHaveBeenCalled()

      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when integration not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      await expect(updateIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
      )

      expect(mockDb.integration.update).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(updateIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegration)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.update).not.toHaveBeenCalled()
    })
  })

  describe('deleteIntegration', () => {
    const mockAccount = 'test-account'
    const mockSocialId = 'test-social-id' as PersonId
    const mockIntegrationKey: IntegrationKey = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid
    }

    test('should allow allowed service to delete integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegrationKey,
        data: {}
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await deleteIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegrationKey)

      expect(mockDb.integration.deleteMany).toHaveBeenCalledWith(mockIntegrationKey)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
    })

    test('should allow verified user to delete their integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegrationKey,
        data: {}
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await deleteIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegrationKey)

      expect(mockDb.integration.deleteMany).toHaveBeenCalledWith(mockIntegrationKey)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when user deletes integration for different social id', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({
        ...mockIntegrationKey,
        data: {}
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await expect(deleteIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegrationKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.deleteMany).not.toHaveBeenCalled()
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when integration not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      await expect(deleteIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegrationKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
      )

      expect(mockDb.integration.deleteMany).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(deleteIntegration(mockCtx, mockDb, mockBranding, mockToken, mockIntegrationKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.deleteMany).not.toHaveBeenCalled()
    })
  })

  describe('getIntegration', () => {
    const mockAccount = 'test-account'
    const mockSocialId = 'test-social-id' as PersonId
    const mockKey: IntegrationKey = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid
    }

    test('should allow verified user to get their integration', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount,
        extra: {}
      })

      const mockIntegration: Integration = {
        ...mockKey,
        data: {}
      }

      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue([
        { _id: mockKey.socialId, personUuid: mockAccount, verifiedOn: 1 }
      ])
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      const result = await getIntegration(mockCtx, mockDb, mockBranding, mockToken, mockKey)
      expect(result).toEqual(mockIntegration)
      expect(mockDb.integration.findOne).toHaveBeenCalledWith(mockKey)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when there is no matching verified social id', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: 'test-account',
        extra: {}
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)

      await expect(getIntegration(mockCtx, mockDb, mockBranding, mockToken, mockKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )
      expect(mockDb.integration.findOne).not.toHaveBeenCalled()
    })

    test('should allow all integration services to get integration', async () => {
      for (const service of integrationServices) {
        ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
          extra: { service }
        })

        const mockIntegration: Integration = {
          ...mockKey,
          data: {}
        }

        ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)

        const result = await getIntegration(mockCtx, mockDb, mockBranding, mockToken, mockKey)
        expect(result).toEqual(mockIntegration)
      }
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)

      await expect(getIntegration(mockCtx, mockDb, mockBranding, mockToken, mockKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )
      expect(mockDb.integration.findOne).not.toHaveBeenCalled()
    })

    test('should return null when integration not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)

      const result = await getIntegration(mockCtx, mockDb, mockBranding, mockToken, mockKey)
      expect(result).toBeNull()
    })
  })

  describe('listIntegrations', () => {
    const mockSocialId = 'test-social-id' as PersonId
    const mockIntegration: Integration = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      data: {}
    }

    test('should allow service to list all integrations without filters', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {})

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({ kind: undefined, workspaceUuid: undefined })
    })

    test('should allow service to list integrations with specific socialId', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {
        socialId: mockSocialId
      })

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({
        socialId: { $in: [mockSocialId] },
        kind: undefined,
        workspaceUuid: undefined
      })
    })

    test('should allow service to filter by kind and workspace', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid
      })

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({
        kind: 'test-kind',
        workspaceUuid: 'test-workspace'
      })
    })

    test('should allow service to filter by null workspace', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {
        workspaceUuid: null
      })

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({
        kind: undefined,
        workspaceUuid: null
      })
    })

    test('should allow regular user to list their verified integrations', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: 'test-account',
        extra: {}
      })

      const verifiedSocialIds = [
        { _id: mockSocialId, personUuid: 'test-account', verifiedOn: 1 },
        { _id: 'another-social-id' as PersonId, personUuid: 'test-account', verifiedOn: 1 }
      ]
      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue(verifiedSocialIds)
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {})

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({
        socialId: { $in: verifiedSocialIds.map((s) => s._id) },
        kind: undefined,
        workspaceUuid: undefined
      })
    })

    test('should allow user to filter their integrations by specific socialId', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: 'test-account',
        extra: {}
      })

      const verifiedSocialIds = [{ _id: mockSocialId, personUuid: 'test-account', verifiedOn: 1 }]
      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue(verifiedSocialIds)
      ;(mockDb.integration.find as jest.Mock).mockResolvedValue([mockIntegration])

      const result = await listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {
        socialId: mockSocialId
      })

      expect(result).toEqual([mockIntegration])
      expect(mockDb.integration.find).toHaveBeenCalledWith({
        socialId: { $in: [mockSocialId] },
        kind: undefined,
        workspaceUuid: undefined
      })
    })

    test('should throw error when user has no verified social ids', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: 'test-account',
        extra: {}
      })
      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue([])

      await expect(listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {})).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.find).not.toHaveBeenCalled()
    })

    test('should throw error when user requests unauthorized socialId', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: 'test-account',
        extra: {}
      })

      const verifiedSocialIds = [{ _id: 'other-social-id' as PersonId, personUuid: 'test-account', verifiedOn: 1 }]
      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue(verifiedSocialIds)

      await expect(
        listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {
          socialId: mockSocialId // Not in user's verified social ids
        })
      ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {})))

      expect(mockDb.integration.find).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })
      ;(mockDb.socialId.find as jest.Mock).mockResolvedValue([])

      await expect(listIntegrations(mockCtx, mockDb, mockBranding, mockToken, {})).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integration.find).not.toHaveBeenCalled()
    })
  })

  describe('addIntegrationSecret', () => {
    test('should allow allowed services to create integration secret', async () => {
      for (const service of integrationServices) {
        jest.clearAllMocks()
        ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
          extra: { service }
        })

        const mockSocialId = 'test-social-id' as PersonId
        const mockSecret: IntegrationSecret = {
          socialId: mockSocialId,
          kind: 'test-kind' as IntegrationKind,
          workspaceUuid: 'test-workspace' as WorkspaceUuid,
          key: 'test-key',
          secret: 'test-secret'
        }

        const mockIntegration: Integration = {
          socialId: mockSecret.socialId,
          kind: mockSecret.kind,
          workspaceUuid: mockSecret.workspaceUuid,
          data: {}
        }

        ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)
        ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
        ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
        ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

        await addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)

        expect(mockDb.integrationSecret.insertOne).toHaveBeenCalledWith(mockSecret)
        expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
      }
    })

    test('should allow verified user services to create their integration secret', async () => {
      jest.clearAllMocks()
      const mockAccount = 'test-account'
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockSecret: IntegrationSecret = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        key: 'test-key',
        secret: 'test-secret'
      }

      const mockIntegration: Integration = {
        socialId: mockSecret.socialId,
        kind: mockSecret.kind,
        workspaceUuid: mockSecret.workspaceUuid,
        data: {}
      }

      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)

      expect(mockDb.integrationSecret.insertOne).toHaveBeenCalledWith(mockSecret)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when user services adds integration secret for different social id', async () => {
      jest.clearAllMocks()
      const mockAccount = 'test-account'
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockSecret: IntegrationSecret = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        key: 'test-key',
        secret: 'test-secret'
      }

      const mockIntegration: Integration = {
        socialId: mockSecret.socialId,
        kind: mockSecret.kind,
        workspaceUuid: mockSecret.workspaceUuid,
        data: {}
      }

      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)

      await expect(addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.insertOne).not.toHaveBeenCalled()
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when integration does not exist', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockSocialId = 'test-social-id' as PersonId
      const mockSecret: IntegrationSecret = {
        socialId: mockSocialId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        key: 'test-key',
        secret: 'test-secret'
      }

      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await expect(addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationNotFound, {}))
      )

      expect(mockDb.integrationSecret.insertOne).not.toHaveBeenCalled()
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
    })

    test('should throw error if secret already exists', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })

      const mockSecret: IntegrationSecret = {
        socialId: 'test-social-id' as PersonId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        key: 'test-key',
        secret: 'test-secret'
      }

      const mockIntegration: Integration = {
        socialId: mockSecret.socialId,
        kind: mockSecret.kind,
        workspaceUuid: mockSecret.workspaceUuid,
        data: {}
      }

      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue(mockIntegration)
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(mockSecret)

      await expect(addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretAlreadyExists, {}))
      )

      expect(mockDb.integrationSecret.insertOne).not.toHaveBeenCalled()
    })

    test('should throw for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      const mockSecret: IntegrationSecret = {
        socialId: 'test-social-id' as PersonId,
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid,
        key: 'test-key',
        secret: 'test-secret'
      }

      await expect(addIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.insertOne).not.toHaveBeenCalled()
    })
  })

  describe('updateIntegrationSecret', () => {
    const mockAccount = 'test-account'
    const mockSocialId = 'test-social-id' as PersonId
    const mockSecret: IntegrationSecret = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      key: 'test-key',
      secret: 'new-secret'
    }

    const mockSecretKey: IntegrationSecretKey = {
      socialId: mockSecret.socialId,
      kind: mockSecret.kind,
      workspaceUuid: mockSecret.workspaceUuid,
      key: mockSecret.key
    }

    test('should allow allowed service to update secret', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecret,
        secret: 'old-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({})

      await updateIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)

      expect(mockDb.integrationSecret.update).toHaveBeenCalledWith(mockSecretKey, { secret: mockSecret.secret })
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
    })

    test('should allow verified user to update their secret', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecret,
        secret: 'old-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({})

      await updateIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)

      expect(mockDb.integrationSecret.update).toHaveBeenCalledWith(mockSecretKey, { secret: mockSecret.secret })
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when user updates secret for different social id', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecret,
        secret: 'old-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })

      await expect(updateIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.update).not.toHaveBeenCalledWith()
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when secret not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      await expect(updateIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretNotFound, {}))
      )

      expect(mockDb.integrationSecret.update).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(updateIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecret)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.findOne).not.toHaveBeenCalled()
      expect(mockDb.integrationSecret.update).not.toHaveBeenCalled()
    })
  })

  describe('deleteIntegrationSecret', () => {
    const mockAccount = 'test-account'
    const mockSocialId = 'test-social-id' as PersonId
    const mockSecretKey: IntegrationSecretKey = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      key: 'test-key'
    }

    test('should allow allowed service to delete secret', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecretKey,
        secret: 'test-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({})

      await deleteIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)

      expect(mockDb.integrationSecret.deleteMany).toHaveBeenCalledWith(mockSecretKey)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({ _id: mockSocialId, verifiedOn: { $gt: 0 } })
    })

    test('should allow verified user to delete their secret', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecretKey,
        secret: 'test-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({})

      await deleteIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)

      expect(mockDb.integrationSecret.deleteMany).toHaveBeenCalledWith(mockSecretKey)
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when user deletes secret for different social id', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        account: mockAccount
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue({
        ...mockSecretKey,
        secret: 'test-secret'
      })
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: 'test-workspace' })
      ;(mockDb.integration.findOne as jest.Mock).mockResolvedValue({})

      await expect(deleteIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.deleteMany).not.toHaveBeenCalledWith()
      expect(mockDb.socialId.findOne).toHaveBeenCalledWith({
        _id: mockSocialId,
        personUuid: mockAccount,
        verifiedOn: { $gt: 0 }
      })
    })

    test('should throw error when secret not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      await expect(deleteIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.IntegrationSecretNotFound, {}))
      )

      expect(mockDb.integrationSecret.deleteMany).not.toHaveBeenCalled()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(deleteIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.deleteMany).not.toHaveBeenCalled()
    })
  })

  describe('getIntegrationSecret', () => {
    const mockSocialId = 'test-social-id' as PersonId
    const mockSecretKey: IntegrationSecretKey = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      key: 'test-key'
    }

    const mockSecret: IntegrationSecret = {
      ...mockSecretKey,
      secret: 'test-secret'
    }

    test('should allow allowed service to get secret', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(mockSecret)

      const result = await getIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)

      expect(result).toEqual(mockSecret)
      expect(mockDb.integrationSecret.findOne).toHaveBeenCalledWith(mockSecretKey)
    })

    test('should return null when integration secret not found', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.findOne as jest.Mock).mockResolvedValue(null)
      ;(mockDb.socialId.findOne as jest.Mock).mockResolvedValue({ _id: mockSocialId })

      const result = await getIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)
      expect(result).toBeNull()
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(getIntegrationSecret(mockCtx, mockDb, mockBranding, mockToken, mockSecretKey)).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.findOne).not.toHaveBeenCalled()
    })
  })

  describe('listIntegrationsSecrets', () => {
    const mockSocialId = 'test-social-id' as PersonId
    const mockSecret: IntegrationSecret = {
      socialId: mockSocialId,
      kind: 'test-kind' as IntegrationKind,
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      key: 'test-key',
      secret: 'test-secret'
    }

    test('should allow service to list all secrets without filters', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.find as jest.Mock).mockResolvedValue([mockSecret])

      const result = await listIntegrationsSecrets(mockCtx, mockDb, mockBranding, mockToken, {})

      expect(result).toEqual([mockSecret])
      expect(mockDb.integrationSecret.find).toHaveBeenCalledWith({
        socialId: undefined,
        kind: undefined,
        workspaceUuid: undefined
      })
    })

    test('should allow service to filter by socialId', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.find as jest.Mock).mockResolvedValue([mockSecret])

      const result = await listIntegrationsSecrets(mockCtx, mockDb, mockBranding, mockToken, {
        socialId: mockSocialId
      })

      expect(result).toEqual([mockSecret])
      expect(mockDb.integrationSecret.find).toHaveBeenCalledWith({
        socialId: mockSocialId,
        kind: undefined,
        workspaceUuid: undefined
      })
    })

    test('should allow service to filter by kind and workspace', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.find as jest.Mock).mockResolvedValue([mockSecret])

      const result = await listIntegrationsSecrets(mockCtx, mockDb, mockBranding, mockToken, {
        kind: 'test-kind' as IntegrationKind,
        workspaceUuid: 'test-workspace' as WorkspaceUuid
      })

      expect(result).toEqual([mockSecret])
      expect(mockDb.integrationSecret.find).toHaveBeenCalledWith({
        kind: 'test-kind',
        workspaceUuid: 'test-workspace',
        socialId: undefined
      })
    })

    test('should allow service to filter by null workspace', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'github' }
      })
      ;(mockDb.integrationSecret.find as jest.Mock).mockResolvedValue([mockSecret])

      const result = await listIntegrationsSecrets(mockCtx, mockDb, mockBranding, mockToken, {
        workspaceUuid: null
      })

      expect(result).toEqual([mockSecret])
      expect(mockDb.integrationSecret.find).toHaveBeenCalledWith({
        kind: undefined,
        workspaceUuid: null,
        socialId: undefined
      })
    })

    test('should throw error for unauthorized service', async () => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
        extra: { service: 'unauthorized-service' }
      })

      await expect(listIntegrationsSecrets(mockCtx, mockDb, mockBranding, mockToken, {})).rejects.toThrow(
        new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      )

      expect(mockDb.integrationSecret.find).not.toHaveBeenCalled()
    })
  })
})

describe('upsertSubscription', () => {
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  } as unknown as MeasureContext

  const mockBranding = null
  const mockToken = 'test-token'

  let mockDb: any
  let getWorkspaceByIdSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()

    mockDb = {
      subscription: {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    }

    // Mock getWorkspaceById utility function
    getWorkspaceByIdSpy = jest.spyOn(utils, 'getWorkspaceById')
  })

  afterAll(() => {
    getWorkspaceByIdSpy.mockRestore()
  })

  test('should create new subscription', async () => {
    const workspaceUuid = 'test-workspace' as WorkspaceUuid
    const accountUuid = 'test-account' as AccountUuid

    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'payment' }
    })

    getWorkspaceByIdSpy.mockResolvedValue({ uuid: workspaceUuid })
    mockDb.subscription.findOne.mockResolvedValue(null)

    const subscriptionData = {
      id: 'sub-123',
      workspaceUuid,
      accountUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123',
      providerCheckoutId: 'checkout-456',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: 'pro'
    }

    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, subscriptionData)

    expect(getWorkspaceByIdSpy).toHaveBeenCalledWith(mockDb, workspaceUuid)
    expect(mockDb.subscription.findOne).toHaveBeenCalledWith({
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123'
    })
    expect(mockDb.subscription.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sub-123',
        workspaceUuid,
        accountUuid,
        provider: 'polar',
        providerSubscriptionId: 'polar-sub-123',
        status: 'active',
        plan: 'pro'
      })
    )
  })

  test('should update existing subscription', async () => {
    const workspaceUuid = 'test-workspace' as WorkspaceUuid
    const accountUuid = 'test-account' as AccountUuid

    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'payment' }
    })

    const existingSubscription = {
      id: 'existing-sub-id',
      workspaceUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123'
    }

    getWorkspaceByIdSpy.mockResolvedValue({ uuid: workspaceUuid })
    mockDb.subscription.findOne.mockResolvedValue(existingSubscription)

    const subscriptionData = {
      id: 'sub-123',
      workspaceUuid,
      accountUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Canceled,
      plan: 'pro',
      canceledAt: Date.now()
    }

    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, subscriptionData)

    expect(mockDb.subscription.update).toHaveBeenCalledWith(
      { id: 'existing-sub-id' },
      expect.objectContaining({
        status: 'canceled',
        canceledAt: subscriptionData.canceledAt
      })
    )
    expect(mockDb.subscription.insertOne).not.toHaveBeenCalled()
  })

  test('should reject non-billing service', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'other-service' }
    })

    const subscriptionData = {
      workspaceUuid: 'test-workspace' as WorkspaceUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123'
    } as any

    await expect(upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, subscriptionData)).rejects.toThrow(
      new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    )

    expect(mockDb.subscription.findOne).not.toHaveBeenCalled()
  })

  test('should reject if workspace not found', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'billing' }
    })

    getWorkspaceByIdSpy.mockResolvedValue(null)

    const subscriptionData = {
      workspaceUuid: 'nonexistent-workspace' as WorkspaceUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123'
    } as any

    await expect(upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, subscriptionData)).rejects.toThrow(
      PlatformError
    )

    expect(mockDb.subscription.findOne).not.toHaveBeenCalled()
  })

  test('should handle subscription with optional fields', async () => {
    const workspaceUuid = 'test-workspace' as WorkspaceUuid
    const accountUuid = 'test-account' as AccountUuid

    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { service: 'payment' }
    })

    getWorkspaceByIdSpy.mockResolvedValue({ uuid: workspaceUuid })
    mockDb.subscription.findOne.mockResolvedValue(null)

    const subscriptionData = {
      id: 'sub-123',
      workspaceUuid,
      accountUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-sub-123',
      providerCheckoutId: 'checkout-456',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Trialing,
      plan: 'storage-100gb',
      periodStart: Date.now(),
      periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      trialEnd: Date.now() + 7 * 24 * 60 * 60 * 1000,
      providerData: {
        customerExternalId: 'cus_123',
        metadata: { source: 'website' }
      }
    }

    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, subscriptionData)

    expect(mockDb.subscription.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCheckoutId: 'checkout-456',
        trialEnd: subscriptionData.trialEnd,
        providerData: subscriptionData.providerData
      })
    )
  })

  // Invariant: at most one active tier subscription per workspace.
  describe('one-active-tier invariant', () => {
    const workspaceUuid = 'ws-1' as WorkspaceUuid
    const accountUuid = 'acc-1' as AccountUuid

    beforeEach(() => {
      ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'payment' } })
      getWorkspaceByIdSpy.mockResolvedValue({ uuid: workspaceUuid })
      mockDb.subscription.findOne.mockResolvedValue(null)
    })

    function tier (over: Record<string, any> = {}): any {
      return {
        id: 'new-sub',
        workspaceUuid,
        accountUuid,
        provider: 'mock',
        providerSubscriptionId: 'mock-new',
        type: SubscriptionType.Tier,
        status: SubscriptionStatus.Active,
        plan: 'team',
        ...over
      }
    }

    test('cancels other active tier when a new tier is activated', async () => {
      mockDb.subscription.find.mockResolvedValue([
        { id: 'old-business', provider: 'stripe', providerSubscriptionId: 'st-1', plan: 'business', providerData: {} }
      ])

      await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier())

      expect(mockDb.subscription.find).toHaveBeenCalledWith({
        workspaceUuid,
        type: 'tier',
        status: { $in: ['active', 'trialing'] }
      })
      expect(mockDb.subscription.update).toHaveBeenCalledWith(
        { id: 'old-business' },
        expect.objectContaining({
          status: 'canceled',
          providerData: expect.objectContaining({ status: 'REPLACED', pending: false })
        })
      )
    })

    test('does not cancel the same subscription being upserted', async () => {
      mockDb.subscription.find.mockResolvedValue([
        { id: 'same', provider: 'mock', providerSubscriptionId: 'mock-new', plan: 'team', providerData: {} }
      ])

      await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier())

      expect(mockDb.subscription.update).not.toHaveBeenCalledWith(
        { id: 'same' },
        expect.objectContaining({ status: 'canceled' })
      )
    })

    test('does not run invariant for non-active status', async () => {
      await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier({ status: SubscriptionStatus.PastDue }))
      expect(mockDb.subscription.find).not.toHaveBeenCalled()
    })

    test('does not run invariant for non-tier type', async () => {
      await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier({ type: SubscriptionType.Package }))
      expect(mockDb.subscription.find).not.toHaveBeenCalled()
    })
  })
})

describe('upsertSubscription - AI package token grant', () => {
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  } as unknown as MeasureContext

  const mockBranding = null
  const mockToken = 'test-token'
  const workspaceUuid = 'ws-tokens' as WorkspaceUuid
  const accountUuid = 'acc-tokens' as AccountUuid

  let mockDb: any
  let getWorkspaceByIdSpy: jest.SpyInstance
  let mockProducer: { send: jest.Mock }

  function pkg (over: Record<string, any> = {}): any {
    return {
      id: 'sub-pkg-1',
      workspaceUuid,
      accountUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-pkg-1',
      type: SubscriptionType.Package,
      status: SubscriptionStatus.Active,
      plan: 'ai-500k',
      periodStart: 1_000,
      limits: { storageLimitGB: 0, trafficLimitGB: 0, meetingMinutesLimit: 0, tokenLimit: 500_000, usersLimit: 0 },
      ...over
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockDb = {
      subscription: {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    }

    getWorkspaceByIdSpy = jest.spyOn(utils, 'getWorkspaceById').mockResolvedValue({ uuid: workspaceUuid } as any)
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'payment' } })

    mockProducer = { send: jest.fn() }
    ;(getMetadata as jest.Mock).mockReturnValue(mockProducer)
  })

  afterAll(() => {
    getWorkspaceByIdSpy.mockRestore()
  })

  /** Token grants only: a package upsert also publishes limitsChanged, which these cases ignore. */
  function grants (): any[] {
    return mockProducer.send.mock.calls.flatMap((c: any[]) => c[2]).filter((e: any) => e.type === 'purchase-activated')
  }

  test('publishes token grant for active package with tokenLimit > 0', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg())

    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [
      workspaceEvents.purchaseActivated('ai-500k', 'sub-pkg-1:1000', 'add-ai-tokens', 500_000)
    ])
  })

  test('does not publish when tokenLimit is 0 (storage package)', async () => {
    const storageLimits = {
      storageLimitGB: 100,
      trafficLimitGB: 0,
      meetingMinutesLimit: 0,
      tokenLimit: 0,
      usersLimit: 0
    }
    await upsertSubscription(
      mockCtx,
      mockDb,
      mockBranding,
      mockToken,
      pkg({ plan: 'storage-100gb', limits: storageLimits })
    )

    expect(grants()).toEqual([])
  })

  test('does not publish when limits are missing', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ limits: undefined }))

    expect(grants()).toEqual([])
  })

  test('does not publish when status is not Active', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ status: SubscriptionStatus.PastDue }))

    expect(grants()).toEqual([])
  })

  test('does not publish when periodStart is undefined', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ periodStart: undefined }))

    expect(grants()).toEqual([])
  })

  test('grantId changes when periodStart changes (renewal grants again)', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ periodStart: 1_000 }))
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ periodStart: 2_000 }))

    expect(grants()).toEqual([
      workspaceEvents.purchaseActivated('ai-500k', 'sub-pkg-1:1000', 'add-ai-tokens', 500_000),
      workspaceEvents.purchaseActivated('ai-500k', 'sub-pkg-1:2000', 'add-ai-tokens', 500_000)
    ])
  })

  test('grantId is stable across a repeated upsert within the same period (idempotent on consumer side)', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ periodStart: 1_000 }))
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, pkg({ periodStart: 1_000 }))

    const [first, second] = grants()
    expect(first.purchaseId).toBe(second.purchaseId)
    expect(first.purchaseId).toBe('sub-pkg-1:1000')
  })

  test('does not publish the token-grant event for a Tier subscription', async () => {
    await upsertSubscription(
      mockCtx,
      mockDb,
      mockBranding,
      mockToken,
      pkg({ type: SubscriptionType.Tier, plan: 'pro' })
    )

    // Tier upserts may still publish a plan limitsChanged event, but never purchaseActivated.
    const purchaseCalls = mockProducer.send.mock.calls.filter(([, , events]) =>
      events.some((e: any) => e.type === QueueWorkspaceEvent.PurchaseActivated)
    )
    expect(purchaseCalls).toHaveLength(0)
  })
})

describe('upsertSubscription - tier plan changed event', () => {
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  } as unknown as MeasureContext

  const mockBranding = null
  const mockToken = 'test-token'
  const workspaceUuid = 'ws-plan' as WorkspaceUuid
  const accountUuid = 'acc-plan' as AccountUuid

  let mockDb: any
  let getWorkspaceByIdSpy: jest.SpyInstance
  let mockProducer: { send: jest.Mock }

  const existingSubscription = {
    id: 'sub-tier-1',
    workspaceUuid,
    provider: 'polar',
    providerSubscriptionId: 'polar-tier-1',
    type: SubscriptionType.Tier,
    status: SubscriptionStatus.Active,
    plan: 'basic',
    limits: { storageLimitGB: 10, trafficLimitGB: 10, meetingMinutesLimit: 100, tokenLimit: 1_000, usersLimit: 5 }
  }

  function tier (over: Record<string, any> = {}): any {
    return {
      id: 'sub-tier-1',
      workspaceUuid,
      accountUuid,
      provider: 'polar',
      providerSubscriptionId: 'polar-tier-1',
      type: SubscriptionType.Tier,
      status: SubscriptionStatus.Active,
      plan: 'basic',
      limits: { storageLimitGB: 10, trafficLimitGB: 10, meetingMinutesLimit: 100, tokenLimit: 1_000, usersLimit: 5 },
      ...over
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockDb = {
      subscription: {
        findOne: jest.fn().mockResolvedValue(existingSubscription),
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn(),
        update: jest.fn()
      }
    }

    getWorkspaceByIdSpy = jest.spyOn(utils, 'getWorkspaceById').mockResolvedValue({ uuid: workspaceUuid } as any)
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'payment' } })

    mockProducer = { send: jest.fn() }
    ;(getMetadata as jest.Mock).mockReturnValue(mockProducer)
  })

  afterAll(() => {
    getWorkspaceByIdSpy.mockRestore()
  })

  test('publishes limitsChanged(Plan, Ok) when the plan actually changed', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier({ plan: 'pro' }))

    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [
      workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)
    ])
  })

  test('does not publish limitsChanged when the upsert repeats the same plan/status/limits', async () => {
    await upsertSubscription(mockCtx, mockDb, mockBranding, mockToken, tier())

    expect(mockProducer.send).not.toHaveBeenCalled()
  })

  test('publishes limitsChanged for a package too: it raises the same effective limits', async () => {
    await upsertSubscription(
      mockCtx,
      mockDb,
      mockBranding,
      mockToken,
      tier({ id: 'sub-pkg-1', type: SubscriptionType.Package, plan: 'pkg-100mb' })
    )

    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [
      workspaceEvents.limitsChanged(LimitCategory.Plan, LimitStatus.Ok)
    ])
  })
})

describe('adminCreateSubscription', () => {
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  } as unknown as MeasureContext
  const mockBranding = null
  const mockToken = 'admin-token'
  const workspaceUuid = 'ws-1' as WorkspaceUuid

  let mockDb: any
  let getWorkspaceByIdSpy: jest.SpyInstance
  let verifyOtpSpy: jest.SpyInstance
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = {
      subscription: {
        find: jest.fn().mockResolvedValue([]),
        insertOne: jest.fn(),
        update: jest.fn()
      },
      account: { findOne: jest.fn().mockResolvedValue({ uuid: 'admin-acc' }) },
      getWorkspaceMembers: jest.fn().mockResolvedValue([]),
      adminAction: { find: jest.fn().mockResolvedValue([]) },
      otp: { deleteMany: jest.fn() }
    }
    getWorkspaceByIdSpy = jest.spyOn(utils, 'getWorkspaceById').mockResolvedValue({ uuid: workspaceUuid } as any)
    verifyOtpSpy = jest.spyOn(utils, 'verifyAdminOtp').mockResolvedValue(undefined)
    logSpy = jest.spyOn(utils, 'logAdminAction').mockResolvedValue(undefined)
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      account: 'admin-acc',
      extra: { admin: 'true', mfaAt: String(Math.floor(Date.now() / 1000)) }
    })
  })

  afterAll(() => {
    getWorkspaceByIdSpy.mockRestore()
    verifyOtpSpy.mockRestore()
    logSpy.mockRestore()
  })

  test('rejects non-admin token', async () => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ account: 'u', extra: {} })
    await expect(
      adminCreateSubscription(mockCtx, mockDb, mockBranding, mockToken, { workspaceUuid, plan: 'team', otpCode: '1' })
    ).rejects.toThrow(new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {})))
    expect(mockDb.subscription.insertOne).not.toHaveBeenCalled()
  })

  test('cancels ALL non-canceled tier subscriptions before inserting (active + past_due, not canceled)', async () => {
    mockDb.subscription.find.mockResolvedValue([
      { id: 'a', provider: 'mock', providerData: {}, status: SubscriptionStatus.Active },
      { id: 'b', provider: 'stripe', providerData: {}, status: SubscriptionStatus.PastDue },
      { id: 'c', provider: 'old', providerData: {}, status: SubscriptionStatus.Canceled }
    ])

    await adminCreateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      plan: 'team',
      otpCode: '1'
    })

    expect(mockDb.subscription.find).toHaveBeenCalledWith({ workspaceUuid, type: 'tier' })
    // 'c' is already canceled -> skipped; 'a' and 'b' get canceled.
    expect(mockDb.subscription.update).toHaveBeenCalledTimes(2)
    expect(mockDb.subscription.update).toHaveBeenCalledWith(
      { id: 'a' },
      expect.objectContaining({
        status: 'canceled',
        providerData: expect.objectContaining({ status: 'ADMIN_REPLACED' })
      })
    )
    expect(mockDb.subscription.update).toHaveBeenCalledWith(
      { id: 'b' },
      expect.objectContaining({ status: 'canceled' })
    )
    expect(mockDb.subscription.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'team', type: 'tier', status: 'active', provider: 'manual' })
    )
  })

  test('passes through custom status (past_due) for unpaid simulation', async () => {
    await adminCreateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      plan: 'team',
      status: SubscriptionStatus.PastDue,
      otpCode: '1'
    })
    expect(mockDb.subscription.insertOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'past_due' }))
  })

  test('falls back to workspace owner when token account is not in account table', async () => {
    mockDb.account.findOne.mockResolvedValue(null)
    mockDb.getWorkspaceMembers.mockResolvedValue([
      { person: 'member-1', role: AccountRole.User },
      { person: 'owner-1', role: AccountRole.Owner }
    ])

    await adminCreateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      plan: 'team',
      otpCode: '1'
    })

    expect(mockDb.subscription.insertOne).toHaveBeenCalledWith(expect.objectContaining({ accountUuid: 'owner-1' }))
  })

  test('does not persist freeLimits; unpaid with free env is not payment-exhausted', async () => {
    // Free fallback comes from FREE_PLAN_LIMITS env (account fills it on read), never persisted.
    ;(getMetadata as jest.Mock).mockReturnValue({ usersLimit: 5, storageLimitGB: 10 })
    await adminCreateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      plan: 'team',
      status: SubscriptionStatus.PastDue,
      otpCode: '1'
    })
    const inserted = mockDb.subscription.insertOne.mock.calls[0][0]
    expect(inserted.freeLimits).toBeUndefined()
  })
})

describe('adminUpdateSubscription', () => {
  const mockCtx = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  } as unknown as MeasureContext
  const mockBranding = null
  const mockToken = 'admin-token'
  const otpCode = '123456'
  const workspaceUuid = 'ws-1' as WorkspaceUuid

  // A live tbank subscription with a bound card — the case the supersede pattern used to break.
  const tbankSub = {
    id: 'sub-1',
    workspaceUuid,
    accountUuid: 'acc-1' as AccountUuid,
    provider: 'tbank',
    providerSubscriptionId: 'tbank_8983976039',
    providerCheckoutId: 'm8tvd8-1-msep7d72',
    type: SubscriptionType.Tier,
    status: SubscriptionStatus.Active,
    plan: 'business',
    amount: 149700,
    limits: { storageLimitGB: 15, trafficLimitGB: 0, meetingMinutesLimit: 0, tokenLimit: 0, usersLimit: 3 },
    periodStart: 1000,
    periodEnd: 2000,
    createdOn: 1000,
    updatedOn: 1000,
    providerData: { rebillId: '1785848580972', recurrent: true, quantity: 3, period: 'monthly', modifiedAt: 1000 }
  }

  let mockDb: any
  let verifyOtpSpy: jest.SpyInstance
  let logAdminActionSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = {
      subscription: {
        findOne: jest.fn().mockResolvedValue({ ...tbankSub, providerData: { ...tbankSub.providerData } }),
        insertOne: jest.fn(),
        update: jest.fn()
      },
      logPaymentOperation: jest.fn(),
      adminAction: { find: jest.fn().mockResolvedValue([]) },
      otp: { deleteMany: jest.fn() }
    }
    verifyOtpSpy = jest.spyOn(utils, 'verifyAdminOtp').mockResolvedValue(undefined)
    logAdminActionSpy = jest.spyOn(utils, 'logAdminAction').mockResolvedValue(undefined)
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      account: 'admin-acc',
      extra: { admin: 'true', mfaAt: String(Math.floor(Date.now() / 1000)) }
    })
    ;(getMetadata as jest.Mock).mockReturnValue(undefined)
  })

  afterAll(() => {
    verifyOtpSpy.mockRestore()
    logAdminActionSpy.mockRestore()
  })

  test('edits the row in place, never inserting a second one', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      seats: 5,
      otpCode
    })

    expect(mockDb.subscription.insertOne).not.toHaveBeenCalled()
    expect(mockDb.subscription.update).toHaveBeenCalledTimes(1)
    expect(mockDb.subscription.update).toHaveBeenCalledWith({ id: 'sub-1' }, expect.anything())
  })

  test('keeps provider and providerSubscriptionId so the subscription stays in the tbank cycles', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      seats: 5,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    // The old supersede inserted a fresh row with provider 'manual' + a new providerSubscriptionId,
    // dropping the subscription out of renewal, expiry mail and webhook lookup.
    expect(patch.provider).toBeUndefined()
    expect(patch.providerSubscriptionId).toBeUndefined()
    expect(patch.status).toBeUndefined()
    expect(patch.canceledAt).toBeUndefined()
    expect(patch.providerData.rebillId).toBe('1785848580972')
    expect(patch.providerData.reason).toBe('ADMIN_EDITED')
  })

  test('mirrors seats into providerData.quantity (renewal and ledger read it, not limits)', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      seats: 5,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    expect(patch.limits.usersLimit).toBe(5)
    // 15GB / 3 seats = 5GB per seat
    expect(patch.limits.storageLimitGB).toBe(25)
    expect(patch.providerData.quantity).toBe(5)
  })

  test('applies a new amount and records both sides in the ledger', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      seats: 5,
      amount: 249500,
      otpCode
    })

    expect(mockDb.subscription.update.mock.calls[0][1].amount).toBe(249500)
    expect(mockDb.logPaymentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'tbank',
        operation: 'update',
        status: 'ADMIN_EDITED',
        actor: 'admin',
        amount: 249500,
        subscriptionId: 'sub-1',
        raw: expect.objectContaining({ seatsBefore: 3, seatsAfter: 5, amountBefore: 149700, amountAfter: 249500 })
      })
    )
  })

  test('applies windowMonthLimit and keeps the seat changes from the same edit', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      seats: 5,
      windowMonthLimit: 1500000,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    // The window branch runs after the seats branch: both must survive.
    expect(patch.limits.windowMonthLimit).toBe(1500000)
    expect(patch.limits.usersLimit).toBe(5)
    expect(patch.limits.storageLimitGB).toBe(25)
    expect(mockDb.logPaymentOperation).toHaveBeenCalledWith(
      expect.objectContaining({ raw: expect.objectContaining({ windowAfter: 1500000 }) })
    )
  })

  test('applies windowMonthLimit on its own, without a seat change', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      windowMonthLimit: 900000,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    expect(patch.limits.windowMonthLimit).toBe(900000)
    // Untouched limits carry over from the existing row.
    expect(patch.limits.usersLimit).toBe(3)
    expect(patch.limits.storageLimitGB).toBe(15)
  })

  test('rejects a negative or fractional windowMonthLimit', async () => {
    for (const windowMonthLimit of [-1, 100.5]) {
      await expect(
        adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
          subscriptionId: 'sub-1',
          windowMonthLimit,
          otpCode
        })
      ).rejects.toThrow()
    }
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
  })

  test('leaves amount alone when the admin did not touch it', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      periodEndMs: 5000,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    expect(patch.amount).toBeUndefined()
    expect(patch.periodEnd).toBe(5000)
    expect(mockDb.logPaymentOperation).toHaveBeenCalledWith(expect.objectContaining({ amount: 149700 }))
  })

  test('mirrors periodEnd into trialEnd for a trial', async () => {
    mockDb.subscription.findOne.mockResolvedValue({
      ...tbankSub,
      status: SubscriptionStatus.Trialing,
      providerData: { ...tbankSub.providerData }
    })

    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
      subscriptionId: 'sub-1',
      periodEndMs: 5000,
      otpCode
    })

    const patch = mockDb.subscription.update.mock.calls[0][1]
    expect(patch.periodEnd).toBe(5000)
    expect(patch.trialEnd).toBe(5000)
  })

  test('rejects a negative or fractional amount (renewal charges it verbatim)', async () => {
    for (const amount of [-1, 100.5]) {
      await expect(
        adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
          subscriptionId: 'sub-1',
          amount,
          otpCode
        })
      ).rejects.toThrow(PlatformError)
    }
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
  })

  test('rejects editing a canceled subscription', async () => {
    mockDb.subscription.findOne.mockResolvedValue({ ...tbankSub, status: SubscriptionStatus.Canceled })
    await expect(
      adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
        subscriptionId: 'sub-1',
        seats: 5,
        otpCode
      })
    ).rejects.toThrow(PlatformError)
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
  })

  test('no-ops when nothing changed', async () => {
    await adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, { subscriptionId: 'sub-1', otpCode })
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
    expect(mockDb.logPaymentOperation).not.toHaveBeenCalled()
  })

  test('a failing ledger write does not roll back the edit', async () => {
    mockDb.logPaymentOperation.mockRejectedValue(new Error('ledger down'))
    await expect(
      adminUpdateSubscription(mockCtx, mockDb, mockBranding, mockToken, {
        subscriptionId: 'sub-1',
        seats: 5,
        otpCode
      })
    ).resolves.toBeUndefined()
    expect(mockDb.subscription.update).toHaveBeenCalledTimes(1)
  })
})

describe('getPersonInfo', () => {
  const mockCtx = {
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    person: {
      findOne: jest.fn()
    },
    socialId: {
      find: jest.fn()
    }
  } as unknown as AccountDB

  const mockBranding = null
  const mockToken = 'test-token'
  const account = 'person-uuid' as PersonUuid

  beforeEach(() => {
    jest.clearAllMocks()
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { admin: 'true' } })
    ;(mockDb.socialId.find as jest.Mock).mockResolvedValue([])
  })

  test('should expose the phone hint', async () => {
    ;(mockDb.person.findOne as jest.Mock).mockResolvedValue({
      uuid: account,
      firstName: 'Test',
      lastName: 'Person',
      phoneHint: '+79000000011'
    })

    const result = await getPersonInfo(mockCtx, mockDb, mockBranding, mockToken, { account })

    expect(result.phoneHint).toBe('+79000000011')
  })

  test('should leave the phone hint undefined when the person has none', async () => {
    ;(mockDb.person.findOne as jest.Mock).mockResolvedValue({
      uuid: account,
      firstName: 'Test',
      lastName: 'Person'
    })

    const result = await getPersonInfo(mockCtx, mockDb, mockBranding, mockToken, { account })

    expect(result.phoneHint).toBeUndefined()
  })
})

describe('updateWorkspaceInfo - delete events', () => {
  const mockCtx = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as MeasureContext
  const mockBranding = null
  const mockToken = 'test-token'
  const workspaceUuid = 'ws-1' as WorkspaceUuid
  const version = { major: 0, minor: 7, patch: 0 }

  let mockDb: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = {
      workspace: { exists: jest.fn().mockResolvedValue(true), update: jest.fn() },
      workspaceStatus: { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() }
    }
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'workspace' } })
  })

  // The worker drops the DB and reports these; without their own cases the mode stayed
  // 'pending-deletion' and every re-pick bumped processing_attempts until the retry cap.
  it('moves the workspace to deleting and clears the attempts', async () => {
    await updateWorkspaceInfo(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      event: 'delete-started',
      version,
      progress: 0
    })

    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'deleting', processingAttempts: 0 })
    )
  })

  it('moves the workspace to deleted when the worker is done', async () => {
    await updateWorkspaceInfo(mockCtx, mockDb, mockBranding, mockToken, {
      workspaceUuid,
      event: 'delete-done',
      version,
      progress: 100
    })

    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'deleted', processingProgress: 100 })
    )
  })
})
