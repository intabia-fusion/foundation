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

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { readdirSync } from 'fs'
import type { OutgoingHttpHeaders } from 'http'
import { join, posix } from 'path'

interface Entry {
  status: number
  headers: OutgoingHttpHeaders
  body: Buffer
}

/**
 * Browsers send a dozen spellings of the same Accept-Encoding. Keying on the raw header would
 * store one copy per spelling, so collapse it to the encoding express-static-gzip will pick.
 */
function chosenEncoding (header: string): string {
  // Must match express-static-gzip's parsing exactly, or we key an entry under an encoding it
  // never served: case-sensitive token, numeric q off the first parameter, q <= 0 is a refusal.
  const accepts = (token: string): boolean =>
    header.split(',').some((part) => {
      const [name, ...params] = part.trim().split(';')
      if (name.trim() !== token) return false
      const q = params[0]?.trim().match(/^q=(.*)$/)
      return q == null || Number.parseFloat(q[1]) > 0
    })
  if (accepts('br')) return 'br'
  if (accepts('gzip')) return 'gzip'
  return ''
}

/** Every path the bundle can serve, as the browser would ask for it. */
function indexBundle (dist: string): Set<string> {
  const paths = new Set<string>()
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(join(dir, e.name), posix.join(prefix, e.name))
      } else {
        paths.add(posix.join(prefix, e.name))
      }
    }
  }
  walk(dist, '/')
  return paths
}

/**
 * Replays static responses from memory. `serve-static` does `stat` + `open` + `read` + `close` on
 * every request; the bundle never changes while the process lives, so the first response for a
 * path can simply be recorded and replayed.
 *
 * Sits in front of the static handler and records whatever it produced - content negotiation,
 * etag and headers all still come from there.
 *
 * Only paths that exist in the bundle are touched. Routes registered after this one - blobs under
 * `/files`, the SPA fallback - must keep reaching their handler: their responses are per-token and
 * a shared cache keyed on the path alone would hand one user another user's body.
 */
export function staticMemoryCache (dist: string, limitBytes: number, maxEntryBytes: number): RequestHandler {
  const entries = new Map<string, Entry>()
  const servable = indexBundle(dist)
  // Recording a response costs a copy of its body. Assets that are asked for once - a crawler
  // walking the bundle, devtools pulling everything - would pay that copy and then be evicted
  // before anyone reads them, so admit a path only on the second request. Bounded by `servable`.
  const seen = new Set<string>()
  let used = 0

  const store = (key: string, entry: Entry): void => {
    entries.set(key, entry)
    used += entry.body.length
    // Map preserves insertion order, so the first key is the least recently used.
    while (used > limitBytes) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      const victim = entries.get(oldest.value)
      if (victim === undefined) break
      entries.delete(oldest.value)
      used -= victim.body.length
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // Source maps are 100MB of the bundle and only devtools ever asks for them; caching one
    // would evict the assets that actually get served.
    if (req.method !== 'GET' || req.path.endsWith('.map') || !servable.has(req.path)) {
      next()
      return
    }
    const key = `${req.path}|${chosenEncoding(String(req.headers['accept-encoding'] ?? ''))}`
    const hit = entries.get(key)
    if (hit !== undefined) {
      entries.delete(key)
      entries.set(key, hit) // move to the most-recent end
      res.writeHead(hit.status, hit.headers)
      res.end(hit.body)
      return
    }

    if (!seen.has(key)) {
      seen.add(key)
      next()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let skip = false
    const asBuffer = (chunk: any, encoding: any): Buffer | undefined => {
      if (chunk == null || typeof chunk === 'function') return undefined
      if (Buffer.isBuffer(chunk)) return chunk
      if (typeof chunk === 'string') {
        return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
      }
      return undefined
    }
    const record = (chunk: any, encoding: any): void => {
      if (skip) return
      const buf = asBuffer(chunk, encoding)
      if (buf === undefined) return
      size += buf.length
      if (size > maxEntryBytes) {
        skip = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    }

    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)
    res.write = function (chunk: any, encoding?: any, cb?: any): boolean {
      record(chunk, encoding)
      return originalWrite(chunk, encoding, cb)
    } as typeof res.write
    res.end = function (chunk?: any, encoding?: any, cb?: any): Response {
      record(chunk, encoding)
      // Only a plain complete body is replayable: no ranges, no 304, no streaming errors.
      if (!skip && res.statusCode === 200 && res.getHeader('content-range') === undefined) {
        store(key, { status: 200, headers: res.getHeaders(), body: Buffer.concat(chunks) })
      }
      return originalEnd(chunk, encoding, cb)
    } as typeof res.end

    next()
  }
}

/** Reads the cache budget from the environment. 0 disables the cache. */
export function staticCacheLimits (): { limitBytes: number, maxEntryBytes: number } {
  // Everything a browser can ask for is 8MB in brotli and 12MB in gzip; 32 holds both with room.
  const mb = Number.parseInt(process.env.STATIC_CACHE_SIZE_MB ?? '32', 10)
  const entryMb = Number.parseInt(process.env.STATIC_CACHE_MAX_FILE_MB ?? '2', 10)
  return {
    limitBytes: (Number.isFinite(mb) ? mb : 32) * 1024 * 1024,
    maxEntryBytes: (Number.isFinite(entryMb) ? entryMb : 2) * 1024 * 1024
  }
}
