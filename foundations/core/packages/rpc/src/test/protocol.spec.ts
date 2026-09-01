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

import { TxProcessor } from '@hcengineering/core'
import { RPCHandler } from '../rpc'

// Both wire formats must carry the same meaning. Where they do not, the difference is listed
// explicitly below - a new entry means the protocol switch changed observable behaviour.

const handler = new RPCHandler()

// Divergence lists are asserted below - print them only when debugging.
const trace: (msg: string) => void =
  (globalThis as any).process?.env?.DEBUG_PROTOCOL === '1'
    ? (msg) => {
        // eslint-disable-next-line no-console
        console.log(msg)
      }
    : () => {}

/**
 * Canonical description of a value. Unlike JSON.stringify it keeps what the protocols disagree
 * about: key presence for undefined values, -0, NaN, array holes, non-index array props and the
 * concrete class of Date/Map/Set/typed arrays.
 */
function sig (v: any, seen = new Set<any>(), depth: number = 0): string {
  if (depth > 12) return '...'
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number') {
    if (Number.isNaN(v)) return 'NaN'
    if (v === 0) return Object.is(v, -0) ? '-0' : '0'
    return String(v)
  }
  if (t === 'bigint') return `bigint(${String(v)})`
  if (t === 'string') return JSON.stringify(v)
  if (t === 'boolean') return String(v)
  if (t === 'function') return 'function'
  if (t === 'symbol') return 'symbol'
  if (seen.has(v)) return '<cycle>'
  seen.add(v)
  try {
    if (v instanceof Date) return `Date(${v.getTime()})`
    if (v instanceof RegExp) return `RegExp(/${v.source}/${v.flags})`
    if (v instanceof Map) {
      return `Map{${[...v.entries()].map(([k, x]) => `${sig(k, seen, depth + 1)}=>${sig(x, seen, depth + 1)}`).join(',')}}`
    }
    if (v instanceof Set) return `Set{${[...v].map((x) => sig(x, seen, depth + 1)).join(',')}}`
    if (ArrayBuffer.isView(v)) return `${v.constructor.name}[${Array.from(v as any).join(',')}]`
    if (v instanceof ArrayBuffer) return `ArrayBuffer[${Array.from(new Uint8Array(v)).join(',')}]`
    if (Array.isArray(v)) {
      const body = Array.from({ length: v.length }, (_, i) => (i in v ? sig(v[i], seen, depth + 1) : '<hole>')).join(
        ','
      )
      const extra = Object.keys(v).filter((k) => !/^\d+$/.test(k))
      const tail =
        extra.length > 0
          ? `+{${extra
              .sort()
              .map((k) => `${k}:${sig((v as any)[k], seen, depth + 1)}`)
              .join(',')}}`
          : ''
      return `[${body}]${tail}`
    }
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${k}:${sig(v[k], seen, depth + 1)}`).join(',')}}`
  } finally {
    seen.delete(v)
  }
}

type Trip = { ok: true, value: any } | { ok: false, error: string }

function trip (make: () => any, binary: boolean): Trip {
  try {
    const wire = handler.protoSerialize(make(), binary)
    return { ok: true, value: handler.protoDeserialize(wire, binary) }
  } catch (err: any) {
    return { ok: false, error: `throw:${String(err?.name ?? 'Error')}` }
  }
}

function tripSig (make: () => any, binary: boolean): string {
  const r = trip(make, binary)
  return r.ok ? sig(r.value) : r.error
}

/** Values the UI can put into a request or the server into a response. */
const values: Array<[string, () => any]> = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['zero', () => 0],
  ['negative-zero', () => -0],
  ['NaN', () => NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['int', () => 42],
  ['float', () => 1.5],
  ['max-safe-int', () => Number.MAX_SAFE_INTEGER],
  ['above-max-safe-int', () => Number.MAX_SAFE_INTEGER + 2],
  ['bigint', () => 10n],
  ['empty-string', () => ''],
  ['ascii', () => 'hello'],
  ['cyrillic', () => 'привет'],
  ['emoji', () => '😀'],
  ['nul-char', () => 'a\u0000b'],
  ['lone-surrogate', () => 'a\uD800b'],
  ['long-string', () => 'x'.repeat(70000)],
  ['true', () => true],
  ['false', () => false],
  ['Date', () => new Date(1700000000000)],
  ['RegExp', () => /ab+c/gi],
  ['Map', () => new Map<any, any>([['a', 1]])],
  ['Set', () => new Set([1, 2])],
  ['Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['ArrayBuffer', () => new Uint8Array([1, 2, 3]).buffer],
  ['empty-array', () => []],
  ['array', () => [1, 'a', true]],
  ['array-with-undefined', () => [undefined, 1]],
  ['array-with-null', () => [null, 1]],
  ['sparse-array', () => [1, , 3]], // eslint-disable-line no-sparse-arrays
  ['empty-object', () => ({})],
  ['object', () => ({ a: 1, b: 'x' })],
  ['object-undefined-field', () => ({ a: undefined, b: 1 })],
  ['object-null-field', () => ({ a: null, b: 1 })],
  ['nested', () => ({ a: { b: { c: [1, { d: 2 }] } } })],
  ['total-array', () => Object.assign([{ _id: 'a' }], { total: 7, lookupMap: { x: 1 } })],
  ['dollar-key', () => ({ $push: { a: 1 } })],
  ['dotted-key', () => ({ 'a.b.c': 1 })],
  ['proto-key', () => JSON.parse('{"__proto__":{"polluted":true}}')],
  ['symbol-value', () => ({ a: Symbol('s') })],
  ['function-value', () => ({ a: () => 1 })],
  ['toJSON-object', () => ({ a: { toJSON: () => 'replaced' } })],
  [
    'cycle',
    () => {
      const o: any = { a: 1 }
      o.self = o
      return o
    }
  ],
  [
    'shared-reference',
    () => {
      const shared = { s: 1 }
      return { a: shared, b: shared }
    }
  ]
]

/** Every DocumentUpdate operator, plus a plain field set, over the interesting value cases. */
function updateVariants (): Array<[string, () => any]> {
  const out: Array<[string, () => any]> = []
  const interesting = values.filter(([n]) =>
    [
      'undefined',
      'null',
      'Date',
      'NaN',
      'negative-zero',
      'object-undefined-field',
      'array-with-undefined',
      'int'
    ].includes(n)
  )
  for (const [name, make] of interesting) {
    out.push([`set:${name}`, () => ({ s: make() })])
    out.push([`push:${name}`, () => ({ $push: { arr: make() } })])
    out.push([`push-each:${name}`, () => ({ $push: { arr: { $each: [make()], $position: 0 } } })])
    out.push([`pull:${name}`, () => ({ $pull: { arr: make() } })])
    out.push([`pull-in:${name}`, () => ({ $pull: { arr: { $in: [make()] } } })])
    out.push([
      `update-embedded:${name}`,
      () => ({ $update: { arr: { $query: { _id: 'e1' }, $update: { v: make() } } } })
    ])
  }
  out.push(['unset:empty-string', () => ({ $unset: { keep: '' } })])
  out.push(['unset:one', () => ({ $unset: { keep: 1 } })])
  out.push(['unset:undefined', () => ({ $unset: { keep: undefined } })])
  out.push(['inc:positive', () => ({ $inc: { n: 2 } })])
  out.push(['inc:negative', () => ({ $inc: { n: -2 } })])
  out.push(['rename', () => ({ $rename: { keep: 'renamed' } })])
  out.push(['mixed-set-and-operator', () => ({ s: undefined, $inc: { n: 1 } })])
  return out
}

/** Query predicates and find options - the other half of what crosses the wire. */
function requestVariants (): Array<[string, () => any]> {
  const out: Array<[string, () => any]> = []
  const preds: Array<[string, any]> = [
    ['$in', { $in: ['a', 'b'] }],
    ['$in-with-undefined', { $in: [undefined, 'b'] }],
    ['$nin', { $nin: ['a'] }],
    ['$all', { $all: ['a'] }],
    ['$like', { $like: '%a%' }],
    ['$regex', { $regex: 'a.*', $options: 'i' }],
    ['$gt', { $gt: 1 }],
    ['$gte', { $gte: 1 }],
    ['$lt', { $lt: 1 }],
    ['$lte', { $lte: 1 }],
    ['$ne', { $ne: null }],
    ['$ne-undefined', { $ne: undefined }],
    ['$exists-true', { $exists: true }],
    ['$exists-false', { $exists: false }],
    ['$size', { $size: 2 }]
  ]
  for (const [name, sel] of preds) {
    out.push([`query:${name}`, () => ({ method: 'findAll', params: ['class:core:Doc', { field: sel }, {}] })])
  }
  out.push([
    'options:full',
    () => ({
      method: 'findAll',
      params: [
        'class:core:Doc',
        {},
        {
          limit: 10,
          total: true,
          sort: { modifiedOn: -1 },
          lookup: { space: 'class:core:Space' },
          projection: { _id: 1 }
        }
      ]
    })
  ])
  out.push([
    'options:undefined-fields',
    () => ({ method: 'findAll', params: ['class:core:Doc', {}, { limit: undefined, total: undefined }] })
  ])
  out.push([
    'tx-retrieve-undefined',
    () => ({ method: 'tx', params: [{ _class: 'TxUpdateDoc', retrieve: undefined }] })
  ])
  out.push(['tx-retrieve-true', () => ({ method: 'tx', params: [{ _class: 'TxUpdateDoc', retrieve: true }] })])
  out.push([
    'response:error',
    () => ({ id: 1, error: { severity: 1, code: 'status:BadRequest', params: {} }, result: undefined })
  ])
  out.push(['response:chunk', () => ({ id: 1, chunk: { index: 0, final: false }, result: [] })])
  out.push([
    'response:rate-limit',
    () => ({ id: 1, rateLimit: { remaining: 1, limit: 10, current: 0, reset: 0, retryAfter: undefined } })
  ])
  return out
}

/** Effect of a round-tripped update on a document - what a client actually ends up showing. */
function appliedSig (make: () => any, binary: boolean): string {
  const r = trip(make, binary)
  if (!r.ok) return r.error
  const doc: any = { _id: 'd1', arr: [{ _id: 'e1', v: 1 }], n: 5, s: 'initial', keep: 'old' }
  try {
    TxProcessor.applyUpdate(doc, r.value)
  } catch (err: any) {
    return `apply-throw:${String(err?.name ?? 'Error')}`
  }
  return sig(doc)
}

function divergences (cases: Array<[string, () => any]>, run: (make: () => any, binary: boolean) => string): string[] {
  const out: string[] = []
  for (const [name, make] of cases) {
    const msgpack = run(make, true)
    const json = run(make, false)
    if (msgpack !== json) out.push(`${name}\n    msgpack: ${msgpack}\n    json:    ${json}`)
  }
  return out
}

function names (rows: string[]): string[] {
  return rows.map((r) => r.split('\n')[0])
}

describe('wire protocol: msgpack vs json', () => {
  it('msgpack round-trips every value unchanged except the ones it cannot represent', () => {
    const broken = values.filter(([, make]) => {
      const before = sig(make())
      return tripSig(make, true) !== before
    })
    expect(names(broken.map(([n]) => n))).toEqual([
      // msgpackr keeps only what structuredClone keeps; TotalArray needs serialize()'s replacer,
      // and it renames __proto__ on purpose.
      'negative-zero',
      'lone-surrogate',
      'sparse-array',
      'total-array',
      'proto-key',
      'symbol-value',
      'function-value',
      'toJSON-object'
    ])
  })

  it('lists every value shape where json differs from msgpack', () => {
    const rows = divergences(values, tripSig)
    trace('value divergences:\n  ' + rows.join('\n  '))
    expect(names(rows)).toEqual([
      'undefined',
      'NaN',
      'Infinity',
      '-Infinity',
      'bigint',
      'lone-surrogate',
      'Date',
      'RegExp',
      'Map',
      'Set',
      'Uint8Array',
      'ArrayBuffer',
      'array-with-undefined',
      'sparse-array',
      'object-undefined-field',
      'total-array',
      'proto-key',
      'symbol-value',
      'function-value',
      'toJSON-object',
      'cycle'
    ])
  })

  it('lists every DocumentUpdate whose applied effect differs', () => {
    const rows = divergences(updateVariants(), appliedSig)
    trace('update divergences:\n  ' + rows.join('\n  '))
    expect(names(rows)).toEqual([
      'set:undefined',
      'push:undefined',
      'push-each:undefined',
      'update-embedded:undefined',
      'set:NaN',
      'push:NaN',
      'push-each:NaN',
      'update-embedded:NaN',
      'set:Date',
      'push:Date',
      'push-each:Date',
      'pull:Date',
      'update-embedded:Date',
      'set:array-with-undefined',
      'push:array-with-undefined',
      'push-each:array-with-undefined',
      'update-embedded:array-with-undefined',
      'set:object-undefined-field',
      'push:object-undefined-field',
      'push-each:object-undefined-field',
      'update-embedded:object-undefined-field',
      'mixed-set-and-operator'
    ])
  })

  it('lists every request/response shape where json differs', () => {
    const rows = divergences(requestVariants(), tripSig)
    trace('request divergences:\n  ' + rows.join('\n  '))
    expect(names(rows)).toEqual([
      'query:$in-with-undefined',
      'query:$ne-undefined',
      'options:undefined-fields',
      'tx-retrieve-undefined',
      'response:error',
      'response:rate-limit'
    ])
  })

  // Deployed clients carry the replacer/reviver pair, so both stay wired into JSON.stringify/parse.
  describe('TotalArray', () => {
    const roundTrip = (result: any, binary: boolean): any =>
      handler.readResponse<any>(handler.serialize({ id: 1, result } as any, binary), binary).result

    it('survives as the response result in both protocols', () => {
      for (const binary of [true, false]) {
        const back = roundTrip(Object.assign([{ _id: 'a' }, { _id: 'b' }], { total: 3, lookupMap: { x: 1 } }), binary)
        expect(Array.isArray(back)).toBe(true)
        expect(back.map((d: any) => d._id)).toEqual(['a', 'b'])
        expect(back.total).toBe(3)
        expect(back.lookupMap).toEqual({ x: 1 })
      }
    })

    it('survives inside a DomainResult in both protocols', () => {
      for (const binary of [true, false]) {
        const back = roundTrip({ domain: 'tx', value: Object.assign([{ _id: 'a' }], { total: 9 }) }, binary)
        expect(back.domain).toBe('tx')
        expect(Array.isArray(back.value)).toBe(true)
        expect(back.value.total).toBe(9)
      }
    })

    it('keeps total when only lookupMap is absent, and vice versa', () => {
      for (const binary of [true, false]) {
        expect(roundTrip(Object.assign([{ _id: 'a' }], { total: 5 }), binary).total).toBe(5)
        expect(roundTrip(Object.assign([{ _id: 'a' }], { lookupMap: { y: 2 } }), binary).lookupMap).toEqual({ y: 2 })
      }
    })

    it('leaves a plain array and a plain object alone', () => {
      for (const binary of [true, false]) {
        const arr = roundTrip([{ _id: 'a' }], binary)
        expect(arr).toEqual([{ _id: 'a' }])
        expect(arr.total).toBeUndefined()
        expect(roundTrip({ dataType: 'TotalArray', value: 'not a wrapper' }, binary)).toEqual({
          dataType: 'TotalArray',
          value: 'not a wrapper'
        })
      }
    })

    // The replacer/reviver pair reaches any depth on json; msgpack has never carried a nested one.
    it('keeps total on a nested array in json, drops it in msgpack', () => {
      const nested = (): any => ({ nested: Object.assign([{ _id: 'a' }], { total: 4 }) })
      expect(roundTrip(nested(), false).nested.total).toBe(4)
      expect(roundTrip(nested(), true).nested.total).toBeUndefined()
    })
  })
})
