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

import { type MeasureContext, type Ref, type Tx } from '@hcengineering/core'
import { getDBClient } from '@hcengineering/postgres-base'

// One cross-workspace query for the latest tx id per workspace (DISTINCT ON = single scan,
// ~1s for ~1000 workspaces). Fills the shared boot cache seeded into cold pipeline builds.
export async function loadLastTxCache (ctx: MeasureContext, dbUrl: string, cache: Map<string, Ref<Tx>>): Promise<void> {
  const ref = getDBClient(dbUrl)
  try {
    const client = await ref.getClient()
    const rows = (await client.unsafe(
      'SELECT DISTINCT ON ("workspaceId") "workspaceId", _id FROM tx ORDER BY "workspaceId", ("modifiedOn")::numeric DESC'
    )) as unknown as Array<{ workspaceId: string, _id: string }>
    for (const row of rows) {
      // Don't clobber a live write-back: if a tx committed during this load, the txPush
      // update is newer than this snapshot, so only seed workspaces not already present.
      if (!cache.has(row.workspaceId)) cache.set(row.workspaceId, row._id as Ref<Tx>)
    }
    ctx.info('last-tx cache loaded', { workspaces: cache.size })
  } catch (err: any) {
    ctx.error('failed to load last-tx cache', { err })
  } finally {
    ref.close()
  }
}
