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

import { MeasureMetricsContext } from '@hcengineering/core'
import { bench, describeBench } from '@hcengineering/measurements'

describeBench('MeasureMetricsContext.with bench', () => {
  it('with - no-op sync wrap, empty params', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    const op = (): number => 1
    await bench('ctx.with sync op, empty params', async () => {
      await ctx.with('child', {}, op)
    })
  })

  it('with - async op, empty params', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    const op = async (): Promise<number> => 1
    await bench('ctx.with async op, empty params', async () => {
      await ctx.with('child', {}, op)
    })
  })

  it('with - sync op, 1 param', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    const op = (): number => 1
    await bench('ctx.with sync, 1 param', async () => {
      await ctx.with('child', { domain: 'x' }, op)
    })
  })

  it('with - deep wrap 8 levels (mimics pipeline)', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    const op = (): number => 1
    await bench('ctx.with 8-level nested', async () => {
      await ctx.with('l1', {}, async (c1) => {
        return await c1.with('l2', {}, async (c2) => {
          return await c2.with('l3', {}, async (c3) => {
            return await c3.with('l4', {}, async (c4) => {
              return await c4.with('l5', {}, async (c5) => {
                return await c5.with('l6', {}, async (c6) => {
                  return await c6.with('l7', {}, async (c7) => {
                    return await c7.with('l8', {}, op)
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  it('newChild only (no with)', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    await bench('ctx.newChild', () => {
      const c = ctx.newChild('child', {})
      c.end()
    })
  })

  it('newChild + end + measure', async () => {
    const ctx = new MeasureMetricsContext('root', {})
    await bench('ctx.newChild + measure', () => {
      const c = ctx.newChild('child', {})
      ;(c as any).measure?.('counter', 1)
      c.end()
    })
  })
})
