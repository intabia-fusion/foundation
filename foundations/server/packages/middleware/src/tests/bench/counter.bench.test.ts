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

import { labelsKey, OneSecondCountersImpl } from '@hcengineering/server-core'
import { bench, describeBench } from '@hcengineering/measurements'

describeBench('counter/labels bench', () => {
  it('labelsKey - undefined', async () => {
    await bench('labelsKey(undefined)', () => {
      const k = labelsKey(undefined)
      if (k !== '') throw new Error('x')
    })
  })

  it('labelsKey - empty', async () => {
    const empty = {}
    await bench('labelsKey({})', () => {
      labelsKey(empty)
    })
  })

  it('labelsKey - single key (typical: { domain })', async () => {
    const d = { domain: 'tx' }
    await bench('labelsKey({domain})', () => {
      labelsKey(d)
    })
  })

  it('labelsKey - 3 keys', async () => {
    const d = { domain: 'tx', op: 'find', user: 'u1' }
    await bench('labelsKey(3 keys)', () => {
      labelsKey(d)
    })
  })

  it('withCounter - typical find request', async () => {
    const c = new OneSecondCountersImpl()
    const op = (): Promise<number> => Promise.resolve(1)
    await bench('withCounter find {domain}', async () => {
      await c.withCounter('find', 1, op, { domain: 'tx' })
    })
  })

  it('withCounter - no labels', async () => {
    const c = new OneSecondCountersImpl()
    const op = (): Promise<number> => Promise.resolve(1)
    await bench('withCounter find (no labels)', async () => {
      await c.withCounter('find', 1, op)
    })
  })
})
