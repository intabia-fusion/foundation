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
import core, {
  AccountRole,
  type AccountUuid,
  type Class,
  type Doc,
  MeasureMetricsContext,
  type Ref,
  type Tx,
  type TxCUD,
  type WorkspaceMemberInfo,
  type WorkspaceUuid
} from '@hcengineering/core'
import {
  type LimitsProvider,
  type Middleware,
  type PipelineContext,
  type PlanLimits,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import { SeatLimitsMiddleware } from '../seatLimits'
import { LIMITS_PROVIDER_VAR, MEMBERS_VERSION_KEY, PLAN_LIMITS_VAR } from '../planLimits'

const WS = 'ws1' as WorkspaceUuid
const uuid = (n: string): AccountUuid => n as unknown as AccountUuid

function member (person: string, role: AccountRole): WorkspaceMemberInfo {
  return { person: uuid(person), role }
}

// A non-message write tx: not whitelisted, so a seatless member is rejected on it.
const WRITE_TX = {
  _class: core.class.TxUpdateDoc,
  space: core.space.Tx,
  objectClass: core.class.Space,
  objectId: 'x'
} as unknown as TxCUD<Doc>

function makeContext (
  members: WorkspaceMemberInfo[],
  usersLimit: number,
  systemAccounts: AccountUuid[] = []
): { context: PipelineContext, provider: LimitsProvider } {
  const provider: LimitsProvider = {
    getPlanLimits: async () => ({ usersLimit }) as unknown as PlanLimits,
    getWorkspaceMembers: async () => members,
    getSystemAccounts: async () => new Set(systemAccounts),
    getReadOnlyAllowedClasses: () => new Set<Ref<Class<Doc>>>()
  }
  const context = {
    workspace: { uuid: WS },
    hierarchy: { isDerived: () => false },
    contextVars: {
      [LIMITS_PROVIDER_VAR]: provider,
      [PLAN_LIMITS_VAR]: { usersLimit, storageLimitGB: 0, tokenLimit: 0, transcriptLimit: 0 },
      [MEMBERS_VERSION_KEY]: new Map<WorkspaceUuid, number>()
    }
  } as unknown as PipelineContext
  return { context, provider }
}

// next-middleware: records that the write passed enforcement.
function makeNext (): { next: Middleware, passed: () => boolean } {
  let didPass = false
  const next = {
    tx: async (): Promise<TxMiddlewareResult> => {
      didPass = true
      return {}
    }
  } as unknown as Middleware
  return { next, passed: () => didPass }
}

async function runTx (
  mw: SeatLimitsMiddleware,
  account: { uuid: AccountUuid, role: AccountRole },
  txes: Tx[] = [WRITE_TX]
): Promise<{ rejected: boolean }> {
  const ctx = new MeasureMetricsContext('test', {})
  ;(ctx as any).contextData = { account: { ...account, fullSocialIds: [] } }
  try {
    await mw.tx(ctx as any, txes)
    return { rejected: false }
  } catch {
    return { rejected: true }
  }
}

describe('SeatLimitsMiddleware', () => {
  const ctx = new MeasureMetricsContext('test', {})

  it('passes a seated member and rejects the overflow member (read-only)', async () => {
    const members = [member('owner', AccountRole.Owner), member('u1', AccountRole.User), member('u2', AccountRole.User)]
    const { context } = makeContext(members, 2)
    const { next } = makeNext()
    const mw = await SeatLimitsMiddleware.create(ctx, context, next)

    // owner + u1 take the 2 seats; u2 is seatless -> read-only reject on a non-message write.
    expect((await runTx(mw, { uuid: uuid('owner'), role: AccountRole.Owner })).rejected).toBe(false)
    expect((await runTx(mw, { uuid: uuid('u1'), role: AccountRole.User })).rejected).toBe(false)
    expect((await runTx(mw, { uuid: uuid('u2'), role: AccountRole.User })).rejected).toBe(true)
  })

  it('excludes aiBot (system account) from the seat count', async () => {
    // limit 1, but aiBot holds a User role in ws_members; it must not eat the single seat.
    const members = [member('u1', AccountRole.User), member('aibot', AccountRole.User)]
    const { context } = makeContext(members, 1, [uuid('aibot')])
    const mw = await SeatLimitsMiddleware.create(ctx, context, makeNext().next)

    expect((await runTx(mw, { uuid: uuid('u1'), role: AccountRole.User })).rejected).toBe(false)
  })

  it('does not count Admin or guest roles toward seats', async () => {
    // Only u1 is seat-eligible; admin/guest ride free even at limit 1.
    const members = [
      member('admin', AccountRole.Admin),
      member('guest', AccountRole.Guest),
      member('u1', AccountRole.User)
    ]
    const { context } = makeContext(members, 1)
    const mw = await SeatLimitsMiddleware.create(ctx, context, makeNext().next)

    expect((await runTx(mw, { uuid: uuid('u1'), role: AccountRole.User })).rejected).toBe(false)
    // A guest is always let through regardless of seat pressure.
    expect((await runTx(mw, { uuid: uuid('guest'), role: AccountRole.Guest })).rejected).toBe(false)
  })

  it('assigns seats by role priority: Owner keeps a seat over a User at the boundary', async () => {
    // limit 1, uuids sorted so a plain User would win by uuid — role priority must put Owner first.
    const members = [member('aaa', AccountRole.User), member('zzz', AccountRole.Owner)]
    const { context } = makeContext(members, 1)
    const mw = await SeatLimitsMiddleware.create(ctx, context, makeNext().next)

    expect((await runTx(mw, { uuid: uuid('zzz'), role: AccountRole.Owner })).rejected).toBe(false)
    expect((await runTx(mw, { uuid: uuid('aaa'), role: AccountRole.User })).rejected).toBe(true)
  })

  it('rebuilds the seat set when the host bumps members-version', async () => {
    // Start: u1 seated, u2 overflow. After u1 leaves and version bumps, u2 gets the seat.
    let members = [member('u1', AccountRole.User), member('u2', AccountRole.User)]
    const { context, provider } = makeContext(members, 1)
    ;(provider as any).getWorkspaceMembers = async () => members
    const mw = await SeatLimitsMiddleware.create(ctx, context, makeNext().next)

    expect((await runTx(mw, { uuid: uuid('u2'), role: AccountRole.User })).rejected).toBe(true)

    members = [member('u2', AccountRole.User)]
    const versions = context.contextVars[MEMBERS_VERSION_KEY] as Map<WorkspaceUuid, number>
    versions.set(WS, 1)

    expect((await runTx(mw, { uuid: uuid('u2'), role: AccountRole.User })).rejected).toBe(false)
  })
})
