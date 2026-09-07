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

import { RPCHandler } from '@hcengineering/rpc'
import { compress, uncompress } from 'snappyjs'

// Wire cost of both protocols with snappy in the measurement, on the shapes the transactor sends.
// Homogeneous payloads flatter msgpackr's record extension - the real numbers are on a DB corpus,
// see docs/memory/rpc-json-protocol.md. Run: BENCH=1 npx jest src/__tests__/protocol-bench.spec.ts

// Timing-based, so it stays out of regular jest runs - same BENCH=1 gate as the other benches.
const benchEnv = (globalThis as any).process?.env?.BENCH
const describeBench: jest.Describe = benchEnv === '1' || benchEnv === 'true' ? describe : describe.skip

const handler = new RPCHandler()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function doc (i: number): any {
  return {
    _id: `65f1a2b3c4d5e6f7a8b9c0${String(i).padStart(2, '0')}`,
    _class: 'tracker:class:Issue',
    space: '65f1a2b3c4d5e6f7a8b9c000',
    modifiedBy: 'core:account:System',
    modifiedOn: 1700000000000 + i,
    createdBy: 'core:account:System',
    createdOn: 1700000000000 + i,
    title: `Issue number ${i} with a reasonably long human title`,
    description: null,
    status: '65f1a2b3c4d5e6f7a8b9c001',
    priority: i % 5,
    number: i,
    assignee: i % 3 === 0 ? null : '65f1a2b3c4d5e6f7a8b9c002',
    component: null,
    milestone: null,
    estimation: 0,
    reportedTime: 0,
    reports: 0,
    childInfo: [],
    identifier: `TSK-${i}`,
    rank: `0|${i.toString(36)}:`,
    comments: i % 7,
    attachments: 0,
    labels: 0,
    subIssues: 0
  }
}

function tx (i: number): any {
  return {
    _id: `tx65f1a2b3c4d5e6f7a8b9${String(i).padStart(4, '0')}`,
    _class: 'core:class:TxUpdateDoc',
    space: 'core:space:Tx',
    objectId: `65f1a2b3c4d5e6f7a8b9c0${String(i).padStart(2, '0')}`,
    objectClass: 'tracker:class:Issue',
    objectSpace: '65f1a2b3c4d5e6f7a8b9c000',
    modifiedBy: 'core:account:System',
    modifiedOn: 1700000000000 + i,
    operations: { priority: i % 5, modifiedOn: 1700000000000 + i },
    retrieve: undefined
  }
}

/** name, iterations, payload factory. Big payloads get fewer runs - percentiles still settle. */
const payloads: Array<[string, number, () => any]> = [
  ['hello', 2500, () => ({ method: 'hello', params: [], binary: false, compression: true })],
  ['single-tx', 2500, () => ({ method: 'tx', params: [tx(1)] })],
  ['tx-broadcast-50', 800, () => ({ result: Array.from({ length: 50 }, (_, i) => tx(i)) })],
  [
    'findAll-200',
    300,
    () => ({
      id: 7,
      result: Object.assign(
        Array.from({ length: 200 }, (_, i) => doc(i)),
        { total: 200 }
      )
    })
  ],
  ['docs-2000', 50, () => ({ id: 8, result: Array.from({ length: 2000 }, (_, i) => doc(i)) })],
  // Model and mixed broadcasts are not one repeated shape - msgpackr's record extension has much
  // less to fold there, so this is the honest counterweight to the homogeneous cases above.
  ['mixed-2000', 50, () => ({ id: 9, result: Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? doc(i) : tx(i))) })]
]

const modes = ['msgpack', 'json'] as const
type Mode = (typeof modes)[number]

function pack (obj: any, mode: Mode): Uint8Array {
  const wire = handler.protoSerialize(obj, mode === 'msgpack')
  return typeof wire === 'string' ? encoder.encode(wire) : wire
}

function unpack (bytes: Uint8Array, mode: Mode): void {
  if (mode === 'msgpack') {
    handler.protoDeserialize(bytes, true)
  } else {
    handler.protoDeserialize(decoder.decode(bytes), false)
  }
}

interface Stat {
  opsPerSec: number
  p50: number
  p90: number
  p99: number
}

function stat (samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return { opsPerSec: 1000 / mean, p50: at(0.5), p90: at(0.9), p99: at(0.99) }
}

interface Row {
  payload: string
  mode: Mode
  ops: number
  raw: number
  snappy: number
  enc: Stat
  dec: Stat
}

function bench (name: string, make: () => any, mode: Mode, iterations: number): Row {
  for (let i = 0; i < 50; i++) unpack(uncompress(compress(pack(make(), mode))), mode)

  const sample = pack(make(), mode)
  const encS: number[] = new Array(iterations)
  const decS: number[] = new Array(iterations)
  // Rebuilding the payload every iteration would time the factory, not the protocol.
  const objs = Array.from({ length: Math.min(iterations, 64) }, () => make())

  for (let i = 0; i < iterations; i++) {
    const obj = objs[i % objs.length]
    let t = performance.now()
    const wire = compress(pack(obj, mode))
    encS[i] = performance.now() - t

    t = performance.now()
    unpack(uncompress(wire), mode)
    decS[i] = performance.now() - t
  }
  return {
    payload: name,
    mode,
    ops: iterations,
    raw: sample.byteLength,
    snappy: compress(sample).byteLength,
    enc: stat(encS),
    dec: stat(decS)
  }
}

describeBench('protocol benchmark', () => {
  it('measures size, throughput and latency percentiles of both protocols', () => {
    const rows: Row[] = []
    for (const [name, iterations, make] of payloads) {
      for (const mode of modes) rows.push(bench(name, make, mode, iterations))
    }

    const num = (v: number, d = 0): string =>
      v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    const delta = (base: number, v: number): string => (base === v ? '-' : `${(((v - base) / base) * 100).toFixed(1)}%`)
    const baseOf = (r: Row): Row => rows.find((x) => x.payload === r.payload && x.mode === 'msgpack') as Row

    const size = [
      '| payload | mode | ops | raw B | snappy B | vs msgpack raw | vs msgpack snappy |',
      '|---|---|---:|---:|---:|---:|---:|'
    ]
    for (const r of rows) {
      const b = baseOf(r)
      size.push(
        `| ${r.payload} | ${r.mode} | ${num(r.ops)} | ${num(r.raw)} | ${num(r.snappy)} | ${delta(b.raw, r.raw)} | ${delta(b.snappy, r.snappy)} |`
      )
    }

    const speed = [
      '| payload | mode | ops | enc/s | enc p50 ms | enc p90 | enc p99 | dec/s | dec p50 ms | dec p90 | dec p99 |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    ]
    for (const r of rows) {
      speed.push(
        `| ${r.payload} | ${r.mode} | ${num(r.ops)} | ${num(r.enc.opsPerSec)} | ${r.enc.p50.toFixed(3)} | ${r.enc.p90.toFixed(3)} | ${r.enc.p99.toFixed(3)} | ${num(r.dec.opsPerSec)} | ${r.dec.p50.toFixed(3)} | ${r.dec.p90.toFixed(3)} | ${r.dec.p99.toFixed(3)} |`
      )
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n### Size (snappy = what goes on the wire)\n\n' +
        size.join('\n') +
        '\n\n### Speed (encode = pack + snappy, decode = unsnappy + unpack)\n\n' +
        speed.join('\n')
    )

    expect(rows.every((r) => r.raw > 0 && r.snappy > 0 && r.enc.opsPerSec > 0)).toBe(true)
  })
})
