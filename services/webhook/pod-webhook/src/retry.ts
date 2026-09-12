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

import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import { QueueTopic, type PlatformQueue } from '@hcengineering/server-core'

import type { TimeMachineMessage } from './types'

// Shared backoff for both consumers: 30s, 1m, 2m, 4m, 8m, then give up. Neither runs its own
// scheduler - both hand the next attempt to time-machine.
export const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 30_000
const MAX_DELAY_MS = 10 * 60_000

export function backoffDelayMs (attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}

// Schedules `data` to be re-delivered to `topic` after `delayMs` via time-machine, keyed by `id` so a
// re-schedule of the same id moves its due date instead of creating a second timer.
export async function scheduleRetry<T> (
  ctx: MeasureContext,
  queue: PlatformQueue,
  workspace: WorkspaceUuid,
  topic: QueueTopic,
  id: string,
  delayMs: number,
  data: T
): Promise<void> {
  const schedule: TimeMachineMessage = {
    type: 'schedule',
    id,
    targetDate: Date.now() + delayMs,
    topic,
    data
  }
  const producer = queue.getProducer<TimeMachineMessage>(ctx, QueueTopic.TimeMachine)
  await producer.send(ctx, workspace, [schedule])
}
