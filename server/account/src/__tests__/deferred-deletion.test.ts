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
  type WorkspaceMode,
  type WorkspaceUuid
} from '@hcengineering/core'
import { PlatformError } from '@hcengineering/platform'
import { decodeTokenVerbose } from '@hcengineering/server-token'

import {
  deletionDeadline,
  findOrphanedWorkspaces,
  getDeletionGraceMs,
  getDeletionReadonlyMs,
  isReadOnlyPending,
  purgeAccount,
  sweepScheduledDeletions
} from '../deletion'
import { performWorkspaceOperation } from '../serviceOperations'
import * as utils from '../utils'
import type { AccountDB, WorkspaceStatus } from '../types'

jest.mock('@hcengineering/server-token', () => ({
  isHumanAdmin: jest.requireActual('@hcengineering/server-token').isHumanAdmin,
  decodeTokenVerbose: jest.fn(),
  generateToken: jest.fn()
}))

jest.mock('../adminOp', () => ({
  requireAdminOp: jest.fn(),
  requireAdminSession: jest.fn(),
  isHumanAdminLogin: jest.fn(),
  verifyAdminOtpLimited: jest.fn()
}))

const DAY = 24 * 60 * 60 * 1000

const ctx = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as unknown as MeasureContext

/** Matches the subset of query operators the deletion sweep uses. */
function matches (row: any, query: Record<string, any>): boolean {
  return Object.entries(query).every(([key, cond]) => {
    const value = row[key]
    if (cond !== null && typeof cond === 'object') {
      if (cond.$lte !== undefined) return value != null && value <= cond.$lte
      return false
    }
    return value === cond
  })
}

interface Fake {
  db: AccountDB
  statuses: Array<Partial<WorkspaceStatus>>
  accounts: Array<{ uuid: AccountUuid, deleteOn?: number }>
  deleted: AccountUuid[]
  events: any[]
}

function fakeDb (
  statuses: Array<Partial<WorkspaceStatus>> = [],
  accounts: Array<{ uuid: AccountUuid, deleteOn?: number }> = [],
  workspacesOfAccount: any[] = [],
  members: Record<string, Array<{ person: AccountUuid, role: AccountRole }>> = {}
): Fake {
  const deleted: AccountUuid[] = []
  const events: any[] = []
  const db = {
    workspaceStatus: {
      find: async (query: any) => statuses.filter((s) => matches(s, query)),
      update: async (query: any, ops: any) => {
        for (const s of statuses.filter((s) => matches(s, query))) {
          Object.assign(s, ops)
        }
      }
    },
    account: {
      find: async (query: any) => accounts.filter((a) => matches(a, query)),
      update: async (query: any, ops: any) => {
        for (const a of accounts.filter((a) => matches(a, query))) {
          Object.assign(a, ops)
        }
      }
    },
    accountEvent: { insertOne: async (e: any) => events.push(e) },
    subscription: { find: async () => [] },
    deleteAccount: async (uuid: AccountUuid) => deleted.push(uuid),
    getAccountWorkspaces: async () => workspacesOfAccount,
    getWorkspaceMembers: async (uuid: WorkspaceUuid) => members[uuid] ?? []
  } as unknown as AccountDB

  return { db, statuses, accounts, deleted, events }
}

describe('deletion schedule', () => {
  const envGrace = process.env.DELETION_GRACE_DAYS
  const envReadonly = process.env.DELETION_READONLY_DAYS

  afterEach(() => {
    // Assigning undefined would store the string "undefined" and poison every later parseInt.
    if (envGrace === undefined) delete process.env.DELETION_GRACE_DAYS
    else process.env.DELETION_GRACE_DAYS = envGrace
    if (envReadonly === undefined) delete process.env.DELETION_READONLY_DAYS
    else process.env.DELETION_READONLY_DAYS = envReadonly
  })

  test('defaults to three weeks with the first week read-only', () => {
    delete process.env.DELETION_GRACE_DAYS
    delete process.env.DELETION_READONLY_DAYS

    expect(getDeletionGraceMs()).toBe(21 * DAY)
    expect(getDeletionReadonlyMs()).toBe(7 * DAY)
    expect(deletionDeadline()).toBeGreaterThan(Date.now() + 20 * DAY)
  })

  test('env overrides the deferral', () => {
    process.env.DELETION_GRACE_DAYS = '2'
    expect(getDeletionGraceMs()).toBe(2 * DAY)
  })

  test('read-only only while the workspace is still active', () => {
    expect(isReadOnlyPending({ mode: 'active', deleteOn: Date.now() })).toBe(true)
    expect(isReadOnlyPending({ mode: 'active' })).toBe(false)
    expect(isReadOnlyPending({ mode: 'archived', deleteOn: Date.now() })).toBe(false)
  })
})

describe('findOrphanedWorkspaces', () => {
  const person = 'p1' as AccountUuid

  test('a workspace with a single owner blocks the account purge', async () => {
    const ws = { uuid: 'w1' as WorkspaceUuid, url: 'w1', status: { mode: 'active' } }
    const { db } = fakeDb([], [], [ws], { w1: [{ person, role: AccountRole.Owner }] })

    expect(await findOrphanedWorkspaces(db, person)).toHaveLength(1)
  })

  test('a workspace already scheduled for deletion does not block', async () => {
    const ws = { uuid: 'w1' as WorkspaceUuid, url: 'w1', status: { mode: 'active', deleteOn: Date.now() } }
    const { db } = fakeDb([], [], [ws], { w1: [{ person, role: AccountRole.Owner }] })

    expect(await findOrphanedWorkspaces(db, person)).toHaveLength(0)
  })

  test('a second owner does not block', async () => {
    const ws = { uuid: 'w1' as WorkspaceUuid, url: 'w1', status: { mode: 'active' } }
    const { db } = fakeDb([], [], [ws], {
      w1: [
        { person, role: AccountRole.Owner },
        { person: 'p2' as AccountUuid, role: AccountRole.Owner }
      ]
    })

    expect(await findOrphanedWorkspaces(db, person)).toHaveLength(0)
  })
})

describe('sweepScheduledDeletions', () => {
  const now = Date.now()

  test('an active workspace goes to archiving once the read-only week is over', async () => {
    const due: Partial<WorkspaceStatus> = {
      workspaceUuid: 'w1' as WorkspaceUuid,
      mode: 'active',
      deleteOn: now + 13 * DAY // 21 - 13 = 8 days elapsed, past the 7 read-only ones
    }
    const fresh: Partial<WorkspaceStatus> = {
      workspaceUuid: 'w2' as WorkspaceUuid,
      mode: 'active',
      deleteOn: now + 20 * DAY
    }
    const { db } = fakeDb([due, fresh])

    await sweepScheduledDeletions(ctx, db)

    expect(due.mode).toBe('archiving-pending-backup')
    expect(fresh.mode).toBe('active')
  })

  test('an archived workspace is purged once the deadline passes', async () => {
    const due: Partial<WorkspaceStatus> = {
      workspaceUuid: 'w1' as WorkspaceUuid,
      mode: 'archived',
      deleteOn: now - 1000
    }
    const waiting: Partial<WorkspaceStatus> = {
      workspaceUuid: 'w2' as WorkspaceUuid,
      mode: 'archived',
      deleteOn: now + 5 * DAY
    }
    const { db } = fakeDb([due, waiting])

    await sweepScheduledDeletions(ctx, db)

    expect(due.mode).toBe('pending-deletion')
    expect(due.isDisabled).toBe(true)
    expect(waiting.mode).toBe('archived')
  })

  test('an archived workspace without a deadline is left alone', async () => {
    const archived: Partial<WorkspaceStatus> = { workspaceUuid: 'w1' as WorkspaceUuid, mode: 'archived' }
    const { db } = fakeDb([archived])

    await sweepScheduledDeletions(ctx, db)

    expect(archived.mode).toBe('archived')
  })

  test('an account past its deadline is purged, one still waiting is not', async () => {
    const { db, deleted, events } = fakeDb(
      [],
      [
        { uuid: 'a1' as AccountUuid, deleteOn: now - 1 },
        { uuid: 'a2' as AccountUuid, deleteOn: now + DAY },
        { uuid: 'a3' as AccountUuid }
      ]
    )

    await sweepScheduledDeletions(ctx, db)

    expect(deleted).toEqual(['a1'])
    expect(events).toHaveLength(1)
  })
})

describe('purgeAccount', () => {
  test('refuses to purge the sole owner of a live workspace', async () => {
    const person = 'p1' as AccountUuid
    const ws = { uuid: 'w1' as WorkspaceUuid, url: 'w1', status: { mode: 'active' } }
    const { db, deleted } = fakeDb([], [], [ws], { w1: [{ person, role: AccountRole.Owner }] })

    await purgeAccount(ctx, db, person)

    expect(deleted).toHaveLength(0)
  })
})

describe('performWorkspaceOperation deletion events', () => {
  let statusById: Record<string, Partial<WorkspaceStatus>>

  const setup = (mode: WorkspaceMode, deleteOn?: number): AccountDB => {
    const status: Partial<WorkspaceStatus> = { workspaceUuid: 'w1' as WorkspaceUuid, mode, deleteOn }
    statusById = { w1: status }
    const { db } = fakeDb([status])
    jest
      .spyOn(utils, 'getWorkspacesInfoWithStatusByIds')
      .mockResolvedValue([{ uuid: 'w1' as WorkspaceUuid, name: 'W1', url: 'w1', status }] as any)
    jest.spyOn(utils, 'logAdminAction').mockResolvedValue(undefined)
    jest.spyOn(utils, 'notifyWorkspaceDeleted').mockResolvedValue(undefined)
    return db
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    ;(decodeTokenVerbose as jest.Mock).mockReturnValue({
      account: 'p1' as AccountUuid,
      workspace: 'w1' as WorkspaceUuid,
      extra: { admin: 'true' }
    })
  })

  test('delete only stamps the deadline, the workspace keeps running', async () => {
    const db = setup('active')

    await performWorkspaceOperation(ctx, db, null, 'token', {
      workspaceId: 'w1' as WorkspaceUuid,
      event: 'delete',
      params: []
    })

    expect(statusById.w1.mode).toBe('active')
    expect(statusById.w1.deleteOn).toBeGreaterThan(Date.now())
  })

  test('cancel-delete on a read-only workspace just drops the deadline', async () => {
    const db = setup('active', Date.now() + DAY)

    await performWorkspaceOperation(ctx, db, null, 'token', {
      workspaceId: 'w1' as WorkspaceUuid,
      event: 'cancel-delete',
      params: []
    })

    expect(statusById.w1.deleteOn).toBeUndefined()
    expect(statusById.w1.mode).toBe('active')
  })

  test('cancel-delete on an archived workspace starts a restore', async () => {
    const db = setup('archived', Date.now() + DAY)

    await performWorkspaceOperation(ctx, db, null, 'token', {
      workspaceId: 'w1' as WorkspaceUuid,
      event: 'cancel-delete',
      params: []
    })

    expect(statusById.w1.deleteOn).toBeUndefined()
    expect(statusById.w1.mode).toBe('pending-restore')
  })

  test('cancel-delete is refused when nothing is scheduled', async () => {
    const db = setup('active')

    await expect(
      performWorkspaceOperation(ctx, db, null, 'token', {
        workspaceId: 'w1' as WorkspaceUuid,
        event: 'cancel-delete',
        params: []
      })
    ).rejects.toThrow(PlatformError)
  })

  test('unarchive clears the deadline together with the archive', async () => {
    const db = setup('archived', Date.now() + DAY)

    await performWorkspaceOperation(ctx, db, null, 'token', {
      workspaceId: 'w1' as WorkspaceUuid,
      event: 'unarchive',
      params: []
    })

    expect(statusById.w1.deleteOn).toBeUndefined()
    expect(statusById.w1.mode).toBe('pending-restore')
  })
})
