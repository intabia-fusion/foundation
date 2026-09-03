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

import type { Doc, Projection } from '@hcengineering/core'
import { addSchema, getSchema, type Schema } from '../schemas'
import { decodeArray, filterProjection, parseDoc, parseDocWithProjection, type DBDoc } from '../utils'

// Timing-based, so it stays out of regular jest runs - same BENCH=1 gate as the other benches.
const describeBench: jest.Describe =
  process.env.BENCH === '1' || process.env.BENCH === 'true' ? describe : describe.skip

// A schema with the typical column mix of a real domain: bigints, a text[], nullable attachedTo.
const schema: Schema = {
  _id: { type: 'text', notNull: true, index: false },
  _class: { type: 'text', notNull: true, index: true },
  space: { type: 'text', notNull: true, index: true },
  modifiedBy: { type: 'text', notNull: true, index: false },
  createdBy: { type: 'text', notNull: false, index: false },
  modifiedOn: { type: 'bigint', notNull: true, index: false },
  createdOn: { type: 'bigint', notNull: false, index: false },
  attachedTo: { type: 'text', notNull: false, index: true },
  progress: { type: 'bigint', notNull: false, index: true },
  estimate: { type: 'bigint', notNull: false, index: false },
  tags: { type: 'text[]', notNull: false, index: false }
}
addSchema('bench_task', schema)

// A row as the pg driver returns it: columns beside the jsonb payload, bigints as strings,
// text[] as a postgres array literal, a lookup column to be dropped.
function makeRow (i: number): DBDoc {
  // Shaped like a raw pg row: bigints and text[] still strings, so it does not type as a Doc.
  return {
    _id: `bench:task:${i}`,
    _class: 'bench:class:Task',
    workspaceId: 'bench-ws',
    space: 'bench:space:S',
    attachedTo: i % 10 === 0 ? null : 'bench:space:S',
    modifiedBy: 'bench:user',
    createdBy: 'bench:user',
    modifiedOn: `${1000000 + i}`,
    createdOn: `${1000000 + i}`,
    progress: `${i % 100}`,
    estimate: i % 7 === 0 ? null : '120',
    tags: '{"a","b","c"}',
    lookup_assignee: 'bench:user',
    data: {
      name: `Task ${i}`,
      description: 'lorem ipsum dolor sit amet '.repeat(3),
      status: 'active',
      order: i % 1000,
      assignee: 'bench:user',
      dueDate: 1000000 + i,
      priority: i % 3,
      labels: ['a', 'b'],
      estimateDetail: { hours: 2, rate: 100 }
    }
  } as unknown as DBDoc
}

// The pre-PR implementation, kept verbatim to measure against.
function parseDocLegacy<T extends Doc> (doc: DBDoc, schema: Schema, keepHash: boolean = false): T {
  const { workspaceId, data, '%hash%': _hash, ...rest } = doc
  for (const key in rest) {
    if (key.startsWith('lookup_') || key.startsWith('reverse_lookup_')) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete rest[key]
      continue
    }
    if ((rest as any)[key] === 'NULL' || (rest as any)[key] === null) {
      if (key === 'attachedTo') {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete rest[key]
      } else {
        ;(rest as any)[key] = null
      }
    } else if (schema[key] !== undefined && schema[key].type === 'bigint') {
      ;(rest as any)[key] = Number.parseInt((rest as any)[key])
    } else if (schema[key] !== undefined && schema[key].type === 'text[]' && typeof (rest as any)[key] === 'string') {
      ;(rest as any)[key] = decodeArray((rest as any)[key])
    }
  }
  const res = {
    ...data,
    ...rest
  } as any as T

  if (keepHash && _hash !== undefined) {
    ;(res as any)['%hash%'] = _hash
  }

  return res
}

// The pre-PR parseDocWithProjection, kept verbatim to measure against.
function parseDocWithProjectionLegacy<T extends Doc> (
  doc: DBDoc,
  domain: string,
  projection?: Projection<T> | undefined
): T {
  const { workspaceId, data, '%hash%': _hash, ...rest } = doc
  const schema = getSchema(domain)
  for (const key in rest) {
    if (key.startsWith('lookup_') || key.startsWith('reverse_lookup_')) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete rest[key]
      continue
    }
    if ((rest as any)[key] === 'NULL' || (rest as any)[key] === null) {
      if (key === 'attachedTo') {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete rest[key]
      } else {
        ;(rest as any)[key] = null
      }
    } else if (schema[key] !== undefined && schema[key].type === 'bigint') {
      ;(rest as any)[key] = Number.parseInt((rest as any)[key])
    } else if (schema[key] !== undefined && schema[key].type === 'text[]' && typeof (rest as any)[key] === 'string') {
      ;(rest as any)[key] = decodeArray((rest as any)[key])
    }
  }
  let resultData = data
  if (projection !== undefined) {
    resultData = filterProjection(data, projection)
  }
  const res = {
    ...resultData,
    ...rest
  } as any as T

  return res
}

describeBench('parseDoc benchmark', () => {
  const N = 50_000

  function bench (name: string, iterations: number, fn: (i: number) => unknown): number {
    fn(0) // warm up
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) {
      fn(i)
    }
    const ns = Number(process.hrtime.bigint() - start) / iterations
    // eslint-disable-next-line no-console
    console.log(`${name.padEnd(40)} ${ns.toFixed(0).padStart(7)} ns/op   ${((ns * 1000) / 1e6).toFixed(2)} ms/1k`)
    return ns
  }

  const rows = (): DBDoc[] => Array.from({ length: N }, (_, i) => makeRow(i))

  it('should parse a row strictly cheaper than the pre-PR spread-based implementation', () => {
    // Sanity: same docs out, and the input row is left untouched.
    const check = makeRow(0)
    check['%hash%'] = 'h1'
    const dataBefore = { ...check.data }
    expect(parseDoc(check, schema, true)).toEqual(parseDocLegacy(check, schema, true))
    expect(check.data).toEqual(dataBefore)

    const legacyBatch = rows()
    const legacyNs = bench('parseDoc (pre-PR, rest + 2 spreads)', N, (i) => parseDocLegacy(legacyBatch[i], schema))
    const optBatch = rows()
    const optNs = bench('parseDoc (optimized, assignColumns)', N, (i) => parseDoc(optBatch[i], schema))

    // eslint-disable-next-line no-console
    console.log(
      `\nspeedup on parseDoc: ${(legacyNs / optNs).toFixed(1)}x   ` +
        `saved per 100k rows: ${(((legacyNs - optNs) * 100000) / 1e6).toFixed(0)} ms`
    )

    // A loose guard - a regression check, not a precise measurement.
    expect(optNs).toBeLessThan(legacyNs)
  })

  it('should parse with projection strictly cheaper than the pre-PR implementation', () => {
    const projection: Projection<any> = { name: 1, description: 1, status: 1 }
    const legacyBatch = rows()
    const legacyNs = bench('parseDocWithProjection (pre-PR)', N, (i) =>
      parseDocWithProjectionLegacy(legacyBatch[i], 'bench_task', projection)
    )
    const optBatch = rows()
    const optNs = bench('parseDocWithProjection (optimized)', N, (i) =>
      parseDocWithProjection(optBatch[i], 'bench_task', projection)
    )

    // eslint-disable-next-line no-console
    console.log(
      `\nspeedup on parseDocWithProjection: ${(legacyNs / optNs).toFixed(1)}x   ` +
        `saved per 100k rows: ${(((legacyNs - optNs) * 100000) / 1e6).toFixed(0)} ms`
    )

    expect(optNs).toBeLessThan(legacyNs)
  })
})
