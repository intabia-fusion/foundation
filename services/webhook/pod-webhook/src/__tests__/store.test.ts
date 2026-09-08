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
import { WebhookStore } from '../store'

const WORKSPACE = 'ws-1' as WorkspaceUuid

describe('WebhookStore: TTL expiry', () => {
  test('getJob returns undefined once a job is past its TTL', () => {
    let now = 1_000
    const store = new WebhookStore(500, () => now)
    store.createJob('job-1', WORKSPACE, 'key-1')

    now += 501
    expect(store.getJob('job-1')).toBeUndefined()
  })

  test('getIdempotentJob returns undefined once the job it points to expired', () => {
    let now = 1_000
    const store = new WebhookStore(500, () => now)
    store.createJob('job-1', WORKSPACE, 'key-1')
    store.putIdempotencyKey('key-1', 'idem-1', 'job-1')

    now += 501
    expect(store.getIdempotentJob('key-1', 'idem-1')).toBeUndefined()
  })
})

describe('WebhookStore: lazy sweep', () => {
  test('a later createJob removes stale entries from the underlying maps, not just hides them', () => {
    let now = 1_000
    const store = new WebhookStore(500, () => now)
    store.createJob('job-1', WORKSPACE, 'key-1')
    store.putIdempotencyKey('key-1', 'idem-1', 'job-1')

    now += 501
    store.createJob('job-2', WORKSPACE, 'key-1') // triggers sweep() as its first step

    // Reach into the private maps: getJob/getIdempotentJob already mask expiry, so only inspecting
    // the maps directly proves the entries were deleted rather than left in place and filtered on read.
    const internals = store as unknown as { jobs: Map<string, unknown>, idempotency: Map<string, string> }
    expect(internals.jobs.has('job-1')).toBe(false)
    expect(internals.idempotency.has('key-1:idem-1')).toBe(false)
    expect(internals.jobs.has('job-2')).toBe(true)
  })
})
