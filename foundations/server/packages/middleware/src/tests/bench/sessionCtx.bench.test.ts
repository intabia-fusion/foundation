//
// Copyright © 2026 Intabia Fusion
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
  type Account,
  AccountRole,
  type AccountUuid,
  type Hierarchy,
  ModelDb,
  Hierarchy as HierarchyCls,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import { SessionDataImpl } from '@hcengineering/server-core'
import { bench, describeBench } from '@hcengineering/measurements'

describeBench('SessionDataImpl allocation bench', () => {
  const hierarchy: Hierarchy = new HierarchyCls()
  const modelDb = new ModelDb(hierarchy)
  const workspace: WorkspaceIds = {
    uuid: 'ws-uuid' as WorkspaceUuid,
    url: 'ws-url',
    dataId: 'ws-data' as any
  }
  const account: Account = {
    uuid: 'u' as AccountUuid,
    role: AccountRole.User,
    primarySocialId: 'social' as any,
    socialIds: ['social' as any],
    fullSocialIds: []
  }
  const socialStrings = new Map<any, any>()

  it('old style: spread workspace on every call', async () => {
    await bench('sessionCtx alloc (spread workspace)', () => {
      const dataId = workspace.dataId ?? (workspace.uuid as unknown as WorkspaceIds['dataId'])
      const spreadWs: WorkspaceIds = { ...workspace, dataId }
      const cd = new SessionDataImpl(
        account,
        'sid',
        false,
        undefined,
        spreadWs,
        false,
        undefined,
        undefined,
        modelDb,
        socialStrings,
        'user',
        undefined
      )
      // Touch a field to defeat dead-code elimination
      if (cd.workspace === undefined) throw new Error('x')
    })
  })

  it('new style: reuse cached workspace reference', async () => {
    // Same precomputation that ClientSession does once in its constructor:
    const dataId = workspace.dataId ?? (workspace.uuid as unknown as WorkspaceIds['dataId'])
    const cachedWorkspace = workspace.dataId === dataId ? workspace : { ...workspace, dataId }
    await bench('sessionCtx alloc (cached workspace)', () => {
      const cd = new SessionDataImpl(
        account,
        'sid',
        false,
        undefined,
        cachedWorkspace,
        false,
        undefined,
        undefined,
        modelDb,
        socialStrings,
        'user',
        undefined
      )
      if (cd.workspace === undefined) throw new Error('x')
    })
  })

  it('new style + getter touch (broadcast lazily allocated)', async () => {
    const dataId = workspace.dataId ?? (workspace.uuid as unknown as WorkspaceIds['dataId'])
    const cachedWorkspace = workspace.dataId === dataId ? workspace : { ...workspace, dataId }
    await bench('sessionCtx alloc + broadcast touch', () => {
      const cd = new SessionDataImpl(
        account,
        'sid',
        false,
        undefined,
        cachedWorkspace,
        false,
        undefined,
        undefined,
        modelDb,
        socialStrings,
        'user',
        undefined
      )
      // This triggers lazy {} {} [] [] alloc inside SessionDataImpl
      if (cd.broadcast.txes.length !== 0) throw new Error('x')
    })
  })
})
