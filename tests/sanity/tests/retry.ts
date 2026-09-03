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

// Its own module, not utils.ts: utils imports page objects, and page objects need these - putting
// them in utils closes an import cycle and the base class of a page comes out undefined.

import { expect } from '@playwright/test'

/**
 * Backoff for retried checks. The UI usually settles within a few hundred ms, so the first retries
 * are cheap; a check written with `intervals: [2000]` pays the full 2s even when the state arrived
 * 50ms in.
 * @public
 */
export const retryIntervals = [50, 100, 200, 400, 800, 1600, 3000]

/**
 * Retries `check` until it stops throwing. Use instead of a hand-written toPass with its own
 * intervals, so the whole suite backs off the same way.
 * @public
 */
export async function retry (check: () => Promise<void> | void, timeout = 30000): Promise<void> {
  await expect(check).toPass({ intervals: retryIntervals, timeout })
}

/**
 * Waits until `read` returns the same value `stableFor` in a row, and returns it.
 *
 * This is the answer to "nothing more must happen": a fixed sleep has to be as long as the slowest
 * case, while polling leaves as soon as the value stops moving.
 * @public
 */
export async function waitStable<T> (
  read: () => Promise<T>,
  {
    stableFor = 2000,
    interval = 250,
    timeout = 30000
  }: { stableFor?: number, interval?: number, timeout?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await read()
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    const current = await read()
    if (current !== last) {
      last = current
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= stableFor) return last
  }
  throw new Error(`value kept changing for ${timeout}ms, last was ${JSON.stringify(last)}`)
}
