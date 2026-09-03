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

import core, { type Class, type Doc, type Ref, toFindResult } from '@hcengineering/core'
import type { Middleware } from '@hcengineering/server-core'
import { QueryJoinMiddleware } from '../../queryJoin'
import { bench, describeBench } from '@hcengineering/measurements'
import { createHarness, makeNextMiddleware } from './harness'

describeBench('QueryJoinMiddleware bench', () => {
  async function setup (): Promise<QueryJoinMiddleware> {
    const h = createHarness()
    const next = makeNextMiddleware(h, {
      findAll: async <T extends Doc>(): Promise<ReturnType<typeof toFindResult<T>>> => toFindResult<T>([])
    })
    return await QueryJoinMiddleware.create(h.ctx, h.pipelineContext, next as unknown as Middleware)
  }

  it('findAll - small simple query', async () => {
    const mw = await setup()
    const q = { archived: false }
    await bench('queryJoin findAll(simple)', async () => {
      await mw.findAll({} as any, core.class.Space as Ref<Class<Doc>>, q, undefined)
    })
  })

  it('findAll - large nested query (JSON.stringify hotspot)', async () => {
    const mw = await setup()
    const q: any = {
      space: { $in: [] as string[] },
      _class: { $in: [] as string[] },
      archived: false,
      modifiedOn: { $gt: 0, $lt: 9_999_999_999 },
      tags: { $in: [] as string[] }
    }
    for (let i = 0; i < 50; i++) {
      q.space.$in.push('space-' + i)
      q._class.$in.push('class-' + i)
      q.tags.$in.push('tag-' + i)
    }
    const opts: any = {
      projection: { _id: 1, _class: 1, modifiedOn: 1, name: 1, archived: 1 },
      lookup: { space: core.class.Space },
      sort: { modifiedOn: -1 }
    }
    await bench('queryJoin findAll(large)', async () => {
      await mw.findAll({} as any, core.class.Space as Ref<Class<Doc>>, q, opts)
    })
  })

  it('findAll - high join rate (many parallel identical calls)', async () => {
    const mw = await setup()
    const q: any = { archived: false }
    await bench('queryJoin findAll(parallel x16)', async () => {
      const ps: Promise<any>[] = []
      for (let i = 0; i < 16; i++) {
        ps.push(mw.findAll({} as any, core.class.Space as Ref<Class<Doc>>, q, undefined))
      }
      await Promise.all(ps)
    })
  })
})
