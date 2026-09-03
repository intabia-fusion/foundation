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

import type { NextFunction, Request, Response } from 'express'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { staticMemoryCache } from '../staticCache'

// The cache only touches paths that exist in the bundle, so the tests need a real one.
const dist = mkdtempSync(join(tmpdir(), 'front-static-'))
for (const name of ['a.js', 'big.js', 'missing.js', 'one.js', 'two.js', 'three.js', 'a.js.map']) {
  writeFileSync(join(dist, name), 'x')
}
const cache = (limit: number, entry: number): any => staticMemoryCache(dist, limit, entry)

// Minimal Response stand-in: records what was written and what the handler replayed.
function makeRes (): any {
  const res: any = {
    statusCode: 200,
    written: [] as Buffer[],
    replayed: undefined as Buffer | undefined,
    headers: {} satisfies Record<string, any>,
    getHeader (name: string) {
      return res.headers[name]
    },
    getHeaders () {
      return res.headers
    },
    write (chunk: any) {
      res.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end (chunk?: any) {
      if (chunk != null) res.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return res
    },
    writeHead (status: number, headers: any) {
      res.statusCode = status
      res.headers = headers
      res.replayedHead = true
      return res
    }
  }
  return res
}

function run (
  mw: any,
  path: string,
  serve: ((res: any) => void) | undefined,
  method = 'GET',
  acceptEncoding = 'br'
): any {
  const req = { method, path, headers: { 'accept-encoding': acceptEncoding } } as unknown as Request
  const res = makeRes()
  let served = false
  const next: NextFunction = () => {
    served = true
    serve?.(res)
  }
  mw(req, res as unknown as Response, next)
  return { res, served }
}

describe('staticMemoryCache', () => {
  it('replays a recorded response without calling the static handler again', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const body = Buffer.from('hello-asset')

    const warm = (res: any): void => {
      res.end(body)
    }
    run(mw, '/a.js', warm) // first sight is never recorded

    const first = run(mw, '/a.js', (res) => {
      res.headers = { 'content-type': 'application/javascript' }
      res.write(body)
      res.end()
    })
    expect(first.served).toBe(true)

    const second = run(mw, '/a.js', undefined)
    expect(second.served).toBe(false)
    expect(Buffer.concat(second.res.written).toString()).toBe('hello-asset')
    expect(second.res.headers['content-type']).toBe('application/javascript')
  })

  it('does not cache a response bigger than the per-entry limit', () => {
    const mw = cache(1024 * 1024, 8)
    const serve = (res: any): void => {
      res.write(Buffer.alloc(64, 1))
      res.end()
    }
    run(mw, '/big.js', serve)
    run(mw, '/big.js', serve)
    expect(run(mw, '/big.js', serve).served).toBe(true)
  })

  it('does not cache non-200 responses', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.statusCode = 404
      res.end(Buffer.from('nope'))
    }
    run(mw, '/missing.js', serve)
    run(mw, '/missing.js', serve)
    expect(run(mw, '/missing.js', serve).served).toBe(true)
  })

  it('evicts the least recently used entry once the budget is spent', () => {
    // Budget fits two 4-byte bodies.
    const mw = cache(8, 1024)
    const serve = (res: any): void => {
      res.end(Buffer.alloc(4, 7))
    }
    for (const p of ['/one.js', '/two.js', '/three.js']) run(mw, p, serve) // first sight
    run(mw, '/one.js', serve)
    run(mw, '/two.js', serve)
    run(mw, '/one.js', undefined) // touch one.js so two.js becomes the oldest
    run(mw, '/three.js', serve) // pushes the budget over, evicts two.js

    expect(run(mw, '/one.js', undefined).served).toBe(false)
    expect(run(mw, '/two.js', serve).served).toBe(true)
  })

  it('never caches a path that is not in the bundle', () => {
    // /files/* and the SPA fallback are registered after this middleware and are per-token.
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('secret-blob'))
    }
    run(mw, '/files/blob-1', serve)
    expect(run(mw, '/files/blob-1', serve).served).toBe(true)
  })

  it('serves one stored copy to every spelling of the same Accept-Encoding', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('brotli-bytes'))
    }
    run(mw, '/a.js', serve, 'GET', 'gzip, deflate, br')
    run(mw, '/a.js', serve, 'GET', 'gzip, deflate, br')
    const other = run(mw, '/a.js', undefined, 'GET', 'br;q=1.0, gzip;q=0.8, *;q=0.1')
    expect(other.served).toBe(false)
    expect(Buffer.concat(other.res.written).toString()).toBe('brotli-bytes')
  })

  it('keeps a client that refuses brotli off the brotli copy', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('brotli-bytes'))
    }
    run(mw, '/a.js', serve, 'GET', 'br, gzip')
    run(mw, '/a.js', serve, 'GET', 'br, gzip')
    expect(run(mw, '/a.js', serve, 'GET', 'br;q=0, gzip').served).toBe(true)
  })

  it('reads q as a number, the way express-static-gzip does', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('brotli-bytes'))
    }
    run(mw, '/a.js', serve, 'GET', 'br, gzip')
    run(mw, '/a.js', serve, 'GET', 'br, gzip')
    // "q=0.0" is still a refusal; a string compare against "q=0" would miss it.
    expect(run(mw, '/a.js', serve, 'GET', 'br;q=0.0, gzip').served).toBe(true)
  })

  it('never records a path on its first request', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('once'))
    }
    run(mw, '/one.js', serve)
    expect(run(mw, '/one.js', serve).served).toBe(true) // second sight admits, still a miss
    expect(run(mw, '/one.js', undefined).served).toBe(false) // third is served from memory
  })

  it('never caches a source map', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('map'))
    }
    run(mw, '/a.js.map', serve)
    expect(run(mw, '/a.js.map', serve).served).toBe(true)
  })

  it('passes non-GET requests straight through', () => {
    const mw = cache(1024 * 1024, 1024 * 1024)
    const serve = (res: any): void => {
      res.end(Buffer.from('x'))
    }
    run(mw, '/a.js', serve, 'POST')
    expect(run(mw, '/a.js', serve, 'POST').served).toBe(true)
  })
})
