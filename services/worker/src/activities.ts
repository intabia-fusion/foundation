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
import type { PlatformQueue } from '@hcengineering/server-core'

// Takes the caller's already-created queue instead of calling getPlatformQueue() here: that opened a
// brand new Kafka client + producer per event, never closed (see
// foundation-tasks/docs/infra/2026-08-29-201-time-machine-deploy.md, TSK-207). PlatformQueue caches
// producers per topic, so reusing the caller's instance reuses the connection across events.
export async function SendTimeEvent (
  ctx: MeasureContext,
  queue: PlatformQueue,
  ws: WorkspaceUuid,
  topic: string,
  data: any
): Promise<void> {
  const producer = queue.getProducer<any>(ctx, topic)
  await producer.send(ctx, ws, [data])
}

export default {
  SendTimeEvent
}
