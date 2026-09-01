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

import type { WorkspaceUuid } from '@hcengineering/core'
import { SendTimeEvent } from '../activities'

const ws1 = 'ws-1' as WorkspaceUuid
const newCtx = (): any => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

/**
 * Mimics PlatformQueueImpl.getProducer's real behaviour (one cached producer per topic) so tests
 * can assert SendTimeEvent goes through that cache - by topic - instead of minting its own.
 */
function createFakeQueue (): { queue: any, creations: Record<string, number>, sends: Record<string, any[][]> } {
  const producers = new Map<string, any>()
  const creations: Record<string, number> = {}
  const sends: Record<string, any[][]> = {}
  const queue: any = {
    getProducer: (_ctx: any, topic: string) => {
      let producer = producers.get(topic)
      if (producer === undefined) {
        creations[topic] = (creations[topic] ?? 0) + 1
        sends[topic] = []
        producer = {
          send: jest.fn(async (_c: any, _ws: WorkspaceUuid, msgs: any[]) => {
            sends[topic].push(msgs)
          })
        }
        producers.set(topic, producer)
      }
      return producer
    }
  }
  return { queue, creations, sends }
}

describe('SendTimeEvent', () => {
  it('reuses the same producer for repeated events on the same topic instead of minting a new one each time', async () => {
    const { queue, creations } = createFakeQueue()
    const ctx = newCtx()

    await SendTimeEvent(ctx, queue, ws1, 'topic-a', { n: 1 })
    await SendTimeEvent(ctx, queue, ws1, 'topic-a', { n: 2 })
    await SendTimeEvent(ctx, queue, ws1, 'topic-a', { n: 3 })

    expect(creations['topic-a']).toBe(1)
  })

  it('takes a separate producer per topic', async () => {
    const { queue, creations } = createFakeQueue()
    const ctx = newCtx()

    await SendTimeEvent(ctx, queue, ws1, 'topic-a', {})
    await SendTimeEvent(ctx, queue, ws1, 'topic-b', {})

    expect(creations).toEqual({ 'topic-a': 1, 'topic-b': 1 })
  })

  it('sends the event data to the producer for its own topic', async () => {
    const { queue, sends } = createFakeQueue()
    const ctx = newCtx()

    await SendTimeEvent(ctx, queue, ws1, 'topic-a', { n: 1 })

    expect(sends['topic-a']).toEqual([[{ n: 1 }]])
  })
})
