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

import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import { setMetadata } from '@hcengineering/platform'
import { decode } from 'jwt-simple'
import { decodeToken, generateToken } from '../token'
import plugin from '../plugin'

// Timing-based, so it stays out of regular jest runs - same BENCH=1 gate as the other benches.
const describeBench: jest.Describe =
  process.env.BENCH === '1' || process.env.BENCH === 'true' ? describe : describe.skip

// A session reuses one token for every REST call it makes, so decodeToken is called far more
// often than tokens are issued. This measures what the cache buys and what a miss costs.
describeBench('decodeToken benchmark', () => {
  const secret = 'bench-secret'
  const account = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as PersonUuid
  const workspace = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' as WorkspaceUuid
  const N = 20000

  beforeAll(() => {
    setMetadata(plugin.metadata.Secret, secret)
    setMetadata(plugin.metadata.Service, undefined)
  })

  function bench (name: string, iterations: number, fn: (i: number) => unknown): number {
    fn(0) // warm up
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) {
      fn(i)
    }
    const ns = Number(process.hrtime.bigint() - start) / iterations
    // eslint-disable-next-line no-console
    console.log(`${name.padEnd(28)} ${ns.toFixed(0).padStart(7)} ns/op   ${((ns * 1000) / 1e6).toFixed(2)} ms/1k`)
    return ns
  }

  it('should decode a repeated token far cheaper than verifying it every time', () => {
    const token = generateToken(account, workspace, { admin: 'true' })
    // Unique tokens never hit the cache - this is the worst case, an insert on every call.
    const unique = Array.from({ length: N }, (_, i) =>
      generateToken(account, workspace, { admin: 'true', nonce: `${i}` })
    )

    const rawNs = bench('jwt-simple decode (no cache)', N, () => decode(token, secret, false))
    const cachedNs = bench('decodeToken (cache hit)', N, () => decodeToken(token))
    // Unique tokens carry a nonce, so compare a miss against a raw decode of the same tokens.
    const rawUniqueNs = bench('jwt-simple decode (unique)', N, (i) => decode(unique[i], secret, false))
    const missNs = bench('decodeToken (cache miss)', N, (i) => decodeToken(unique[i]))

    // eslint-disable-next-line no-console
    console.log(
      `\nspeedup on hit: ${(rawNs / cachedNs).toFixed(1)}x   ` +
        `miss overhead: ${(((missNs - rawUniqueNs) / rawUniqueNs) * 100).toFixed(0)}%   ` +
        `saved per 100k calls: ${(((rawNs - cachedNs) * 100000) / 1e6).toFixed(0)} ms`
    )

    // Loose bounds - this runs on CI machines under load, it is a guard against regressions,
    // not a precise measurement.
    expect(cachedNs).toBeLessThan(rawNs / 2)
    expect(missNs).toBeLessThan(rawUniqueNs * 2)
  })
})
