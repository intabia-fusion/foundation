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

import { AccountRole, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { getMetadata } from '@hcengineering/platform'
import { decodeTokenVerbose } from '@hcengineering/server-token'

import { getRegionTopic } from '@hcengineering/server-core'

import { accountPlugin } from '../plugin'
import type { AccountDB } from '../types'
import { publishWorkspaceWakeup } from '../utils'
import { performWorkspaceOperation, updateWorkspaceInfo } from '../serviceOperations'
import { deleteWorkspace, getWorkspaceInfo } from '../operations'

jest.mock('@hcengineering/platform', () => {
  const actual = jest.requireActual('@hcengineering/platform')
  return {
    ...actual,
    ...actual.default,
    getMetadata: jest.fn()
  }
})

jest.mock('@hcengineering/server-token', () => ({
  decodeTokenVerbose: jest.fn(),
  generateToken: jest.fn(),
  // Service tokens here, so no admin OTP path.
  isHumanAdmin: () => false
}))

// deleteWorkspace confirms with an OTP; the queue wiring is what this suite checks.
jest.mock('../utils', () => ({
  ...jest.requireActual('../utils'),
  verifyAdminOtp: jest.fn()
}))

const workspaceUuid = 'ws-uuid' as WorkspaceUuid

const mockProducer = { send: jest.fn() }
const mockQueue = { getProducer: jest.fn().mockReturnValue(mockProducer) }

function mockRegionalQueue (extra?: (key: any) => any): void {
  ;(getMetadata as jest.Mock).mockImplementation((key) => {
    if (key === accountPlugin.metadata.RegionalQueue) return mockQueue
    return extra?.(key)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockProducer.send.mockResolvedValue(undefined)
  mockQueue.getProducer.mockReturnValue(mockProducer)
})

describe('getRegionTopic', () => {
  test('prefixes topic with region', () => {
    expect(getRegionTopic('workspace-wakeup', 'eu')).toBe('eu.workspace-wakeup')
  })

  test('empty or missing region gives bare topic', () => {
    expect(getRegionTopic('workspace-wakeup', '')).toBe('workspace-wakeup')
    expect(getRegionTopic('workspace-wakeup', undefined)).toBe('workspace-wakeup')
    expect(getRegionTopic('workspace-wakeup', null)).toBe('workspace-wakeup')
  })
})

describe('publishWorkspaceWakeup', () => {
  const mockCtx = {
    warn: jest.fn(),
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {} as unknown as AccountDB

  test('does not throw and skips send when queue is not configured', async () => {
    ;(getMetadata as jest.Mock).mockReturnValue(undefined)

    await expect(publishWorkspaceWakeup(mockCtx, mockDb, workspaceUuid, 'x')).resolves.toBeUndefined()
    expect(mockCtx.warn).toHaveBeenCalled()
    expect(mockProducer.send).not.toHaveBeenCalled()
  })

  test('does not throw when producer.send rejects', async () => {
    mockRegionalQueue()
    mockProducer.send.mockRejectedValue(new Error('boom'))

    await expect(publishWorkspaceWakeup(mockCtx, mockDb, workspaceUuid, 'x')).resolves.toBeUndefined()
    expect(mockCtx.error).toHaveBeenCalled()
  })

  test('sends to the regional topic on happy path', async () => {
    mockRegionalQueue()

    await publishWorkspaceWakeup(mockCtx, mockDb, workspaceUuid, 'x')

    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'x')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'x' }])
  })

  test('empty region goes to the bare topic', async () => {
    mockRegionalQueue()

    await publishWorkspaceWakeup(mockCtx, mockDb, workspaceUuid, '')

    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', '')
  })
})

describe('updateWorkspaceInfo wakeup', () => {
  const mockCtx = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    workspace: {
      exists: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn()
    },
    workspaceStatus: {
      findOne: jest.fn(),
      update: jest.fn()
    }
  } as unknown as AccountDB

  beforeEach(() => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ extra: { service: 'workspace' } })
    ;(mockDb.workspace.exists as jest.Mock).mockResolvedValue(true)
    mockRegionalQueue()
  })

  test('delete-started sets mode deleting and resets attempts', async () => {
    await updateWorkspaceInfo(mockCtx, mockDb, null, 'token', {
      workspaceUuid,
      event: 'delete-started',
      version: { major: 1, minor: 0, patch: 0 },
      progress: 10
    })

    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'deleting', processingAttempts: 0, processingProgress: 10 })
    )
  })

  test('delete-done sets mode deleted and progress 100', async () => {
    await updateWorkspaceInfo(mockCtx, mockDb, null, 'token', {
      workspaceUuid,
      event: 'delete-done',
      version: { major: 1, minor: 0, patch: 0 },
      progress: 100
    })

    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'deleted', processingProgress: 100 })
    )
  })

  test('migrate-clean-done wakes up target region', async () => {
    ;(mockDb.workspaceStatus.findOne as jest.Mock).mockResolvedValue({ targetRegion: 'eu' })

    await updateWorkspaceInfo(mockCtx, mockDb, null, 'token', {
      workspaceUuid,
      event: 'migrate-clean-done',
      version: { major: 1, minor: 0, patch: 0 },
      progress: 50
    })

    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'eu')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'eu' }])
  })

  test('archiving-backup-done wakes up workspace region', async () => {
    ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ region: 'us' })

    await updateWorkspaceInfo(mockCtx, mockDb, null, 'token', {
      workspaceUuid,
      event: 'archiving-backup-done',
      version: { major: 1, minor: 0, patch: 0 },
      progress: 50
    })

    expect(mockDb.workspace.findOne).toHaveBeenCalledWith({ uuid: workspaceUuid })
    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'us')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'us' }])
  })

  test('progress event does not trigger wakeup', async () => {
    await updateWorkspaceInfo(mockCtx, mockDb, null, 'token', {
      workspaceUuid,
      event: 'progress',
      version: { major: 1, minor: 0, patch: 0 },
      progress: 50
    })

    expect(mockProducer.send).not.toHaveBeenCalled()
  })
})

describe('performWorkspaceOperation delete', () => {
  const mockCtx = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    workspaceStatus: {
      update: jest.fn()
    },
    workspace: {
      find: jest.fn(),
      findOne: jest.fn()
    }
  } as unknown as AccountDB

  beforeEach(() => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      extra: { admin: 'true', service: 'workspace' },
      account: 'admin-account',
      workspace: workspaceUuid
    })
    mockRegionalQueue()
  })

  test('deletes active workspace and wakes up its region', async () => {
    const mockDbTyped = mockDb as any
    mockDbTyped.workspaceStatus.find = jest.fn().mockResolvedValue([{ workspaceUuid, mode: 'active' }])
    mockDbTyped.workspace.find = jest.fn().mockResolvedValue([{ uuid: workspaceUuid, region: 'us' }])

    const result = await performWorkspaceOperation(mockCtx, mockDb, null, 'token', {
      workspaceId: workspaceUuid,
      event: 'delete',
      params: []
    })

    expect(result).toBe(true)
    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'pending-deletion' })
    )
    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'us')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'us' }])
  })

  test('throws for non-active workspace', async () => {
    const mockDbTyped = mockDb as any
    mockDbTyped.workspaceStatus.find = jest.fn().mockResolvedValue([{ workspaceUuid, mode: 'archived' }])
    mockDbTyped.workspace.find = jest.fn().mockResolvedValue([{ uuid: workspaceUuid, region: 'us' }])

    await expect(
      performWorkspaceOperation(mockCtx, mockDb, null, 'token', {
        workspaceId: workspaceUuid,
        event: 'delete',
        params: []
      })
    ).rejects.toThrow()

    expect(mockProducer.send).not.toHaveBeenCalled()
  })
})

describe('deleteWorkspace', () => {
  const mockCtx = {
    error: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    getWorkspaceRole: jest.fn(),
    workspaceStatus: {
      update: jest.fn()
    },
    workspace: {
      findOne: jest.fn()
    }
  } as unknown as AccountDB

  beforeEach(() => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({ account: 'owner-account', workspace: workspaceUuid })
    mockRegionalQueue()
  })

  test('non-owner is forbidden', async () => {
    ;(mockDb.getWorkspaceRole as jest.Mock).mockResolvedValue(AccountRole.User)

    await expect(deleteWorkspace(mockCtx, mockDb, null, 'token', { otpCode: '000000' })).rejects.toThrow()
    expect(mockDb.workspaceStatus.update).not.toHaveBeenCalled()
  })

  test('owner deletes workspace and triggers wakeup', async () => {
    ;(mockDb.getWorkspaceRole as jest.Mock).mockResolvedValue(AccountRole.Owner)
    ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: workspaceUuid, region: 'us' })

    await deleteWorkspace(mockCtx, mockDb, null, 'token', { otpCode: '000000' })

    expect(mockDb.workspaceStatus.update).toHaveBeenCalledWith(
      { workspaceUuid },
      expect.objectContaining({ mode: 'pending-deletion', processingAttempts: 0 })
    )
    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'us')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'us' }])
  })
})

describe('getWorkspaceInfo dormant wakeup', () => {
  const mockCtx = {
    warn: jest.fn()
  } as unknown as MeasureContext

  const mockDb = {
    getWorkspaceRole: jest.fn(),
    workspace: {
      findOne: jest.fn()
    },
    workspaceStatus: {
      findOne: jest.fn(),
      update: jest.fn()
    }
  } as unknown as AccountDB

  const dayMs = 24 * 60 * 60 * 1000

  beforeEach(() => {
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      account: 'user-account',
      workspace: workspaceUuid,
      extra: {}
    })
    ;(mockDb.getWorkspaceRole as jest.Mock).mockResolvedValue(AccountRole.User)
    ;(mockDb.workspace.findOne as jest.Mock).mockResolvedValue({ uuid: workspaceUuid, region: 'us' })
  })

  function mockLiveness (days: number | undefined): void {
    mockRegionalQueue((key) => (key === accountPlugin.metadata.WsLivenessDays ? days : undefined))
  }

  test('dormant workspace triggers wakeup', async () => {
    mockLiveness(7)
    ;(mockDb.workspaceStatus.findOne as jest.Mock).mockResolvedValue({
      mode: 'active',
      isDisabled: false,
      lastVisit: Date.now() - 10 * dayMs
    })

    await getWorkspaceInfo(mockCtx, mockDb, null, 'token', { updateLastVisit: true })

    expect(mockQueue.getProducer).toHaveBeenCalledWith(mockCtx, 'workspace-wakeup', 'us')
    expect(mockProducer.send).toHaveBeenCalledWith(mockCtx, workspaceUuid, [{ region: 'us' }])
  })

  test('fresh lastVisit does not trigger wakeup', async () => {
    mockLiveness(7)
    ;(mockDb.workspaceStatus.findOne as jest.Mock).mockResolvedValue({
      mode: 'active',
      isDisabled: false,
      lastVisit: Date.now()
    })

    await getWorkspaceInfo(mockCtx, mockDb, null, 'token', { updateLastVisit: true })

    expect(mockProducer.send).not.toHaveBeenCalled()
  })

  test('liveness not configured does not trigger wakeup', async () => {
    mockLiveness(undefined)
    ;(mockDb.workspaceStatus.findOne as jest.Mock).mockResolvedValue({
      mode: 'active',
      isDisabled: false,
      lastVisit: Date.now() - 10 * dayMs
    })

    await getWorkspaceInfo(mockCtx, mockDb, null, 'token', { updateLastVisit: true })

    expect(mockProducer.send).not.toHaveBeenCalled()
  })
})
