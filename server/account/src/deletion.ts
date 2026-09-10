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
  isActiveMode,
  isDeletingMode,
  type AccountUuid,
  type MeasureContext,
  type WorkspaceMode
} from '@hcengineering/core'

import { AccountEventType, type AccountDB, type WorkspaceInfoWithStatus } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Full deferral: from the deletion request to the irreversible purge. */
export function getDeletionGraceMs (): number {
  return parseInt(process.env.DELETION_GRACE_DAYS ?? '21') * DAY_MS
}

/** Head of the deferral, while the workspace still opens read-only so its data can be taken out. */
export function getDeletionReadonlyMs (): number {
  return parseInt(process.env.DELETION_READONLY_DAYS ?? '7') * DAY_MS
}

/** When a deletion requested now must complete. */
export function deletionDeadline (): number {
  return Date.now() + getDeletionGraceMs()
}

/** A workspace scheduled for deletion opens read-only until it gets archived. */
export function isReadOnlyPending (status: { mode: WorkspaceMode, deleteOn?: number }): boolean {
  return status.deleteOn != null && isActiveMode(status.mode)
}

/**
 * Workspaces the account is the last owner of. Deleting the account would leave them ownerless,
 * so they have to be scheduled for deletion first. Already scheduled ones do not block.
 */
export async function findOrphanedWorkspaces (
  db: AccountDB,
  uuid: AccountUuid
): Promise<WorkspaceInfoWithStatus[]> {
  const blocking: WorkspaceInfoWithStatus[] = []
  for (const ws of await db.getAccountWorkspaces(uuid)) {
    if (isDeletingMode(ws.status.mode) || ws.status.deleteOn != null) continue
    const owners = (await db.getWorkspaceMembers(ws.uuid)).filter((m) => m.role === AccountRole.Owner)
    if (owners.length === 1 && owners[0].person === uuid) {
      blocking.push(ws)
    }
  }
  return blocking
}

/**
 * Moves scheduled rows to their next state. Every step is a conditional update, so several account
 * pods running this in parallel is harmless.
 */
export async function sweepScheduledDeletions (ctx: MeasureContext, db: AccountDB): Promise<void> {
  const now = Date.now()
  const archiveDue = now + getDeletionGraceMs() - getDeletionReadonlyMs()

  for (const status of await db.workspaceStatus.find({ deleteOn: { $lte: archiveDue }, mode: 'active' })) {
    ctx.info('Archiving a workspace scheduled for deletion', {
      workspace: status.workspaceUuid,
      deleteOn: status.deleteOn
    })
    await db.workspaceStatus.update(
      { workspaceUuid: status.workspaceUuid, mode: 'active' },
      { mode: 'archiving-pending-backup', processingAttempts: 0, processingProgress: 0, lastProcessingTime: 0 }
    )
  }

  for (const status of await db.workspaceStatus.find({ deleteOn: { $lte: now }, mode: 'archived' })) {
    ctx.info('Deleting a workspace whose deferral is over', { workspace: status.workspaceUuid })
    await db.workspaceStatus.update(
      { workspaceUuid: status.workspaceUuid, mode: 'archived' },
      { mode: 'pending-deletion', isDisabled: true, processingAttempts: 0, processingProgress: 0, lastProcessingTime: 0 }
    )
  }

  for (const account of await db.account.find({ deleteOn: { $lte: now } })) {
    await purgeAccount(ctx, db, account.uuid)
  }
}

/** Irreversible: the account, its membership and everything identifying the person go away. */
export async function purgeAccount (ctx: MeasureContext, db: AccountDB, uuid: AccountUuid): Promise<void> {
  const orphaned = await findOrphanedWorkspaces(db, uuid)
  if (orphaned.length > 0) {
    // Should not happen: scheduling requires the owned workspaces to be scheduled too.
    ctx.error('Not purging an account: still the sole owner of a workspace', {
      uuid,
      workspaces: orphaned.map((ws) => ws.url)
    })
    return
  }

  await db.deleteAccount(uuid)
  await db.accountEvent.insertOne({
    accountUuid: uuid,
    eventType: AccountEventType.ACCOUNT_DELETED,
    time: Date.now()
  })
  ctx.info('Account purged', { uuid })
}
