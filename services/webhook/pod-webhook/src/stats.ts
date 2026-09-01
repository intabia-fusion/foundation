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

import core, { type MeasureContext, type Ref } from '@hcengineering/core'
import type { RestClient } from '@hcengineering/api-client'
import setting, { type WebhookStat } from '@hcengineering/setting'

export type WebhookStatDirection = 'in' | 'out'

// direction is a fixed literal and target is always a colon-free id (keyId is a randomUUID(),
// Ref<WebhookEndpoint> is generateId() - both hex/hyphen only) - so the first two ':' always land
// right after direction and target, unambiguously, whatever ':' appears inside `type` (e.g. an
// ApiKeyOperation like 'issue:create'). Different (direction, target, type) tuples can never collide.
function statId (direction: WebhookStatDirection, target: string, type: string): Ref<WebhookStat> {
  return `${direction}:${target}:${type}` as Ref<WebhookStat>
}

/**
 * Bumps the (direction, target, type) counter by 1, creating the doc on first use. Never throws - a
 * counter must never break the delivery or ingest job it's counting, so every failure is logged and
 * swallowed.
 *
 * A plain SQL UPDATE on a missing row is a silent no-op (no error), so existence is checked with a
 * findOne first rather than by catching a failed update. Two concurrent first bumps for the same
 * tuple can both see no doc and both try to create one with the same deterministic _id - the loser's
 * createDoc fails on the duplicate key and falls back to the same $inc update as every later call.
 */
export async function bumpWebhookStat (
  ctx: MeasureContext,
  rest: RestClient,
  direction: WebhookStatDirection,
  target: string,
  type: string
): Promise<void> {
  const _id = statId(direction, target, type)
  try {
    const existing = await rest.findOne(setting.class.WebhookStat, { _id })
    if (existing !== undefined) {
      await rest.updateDoc(setting.class.WebhookStat, core.space.Workspace, _id, {
        $inc: { count: 1 },
        lastOn: Date.now()
      })
      return
    }
    try {
      await rest.createDoc(
        setting.class.WebhookStat,
        core.space.Workspace,
        { direction, target, type, count: 1, lastOn: Date.now() },
        _id
      )
    } catch {
      // Lost the create race to a concurrent bump for the same tuple - fall back to the increment.
      await rest.updateDoc(setting.class.WebhookStat, core.space.Workspace, _id, {
        $inc: { count: 1 },
        lastOn: Date.now()
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.error('webhook stat bump failed', { direction, target, type, error: message })
  }
}
