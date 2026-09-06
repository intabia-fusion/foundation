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

import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { createDistServer } from '../distServer'

// The artifact is large enough to span several stream chunks so that partial
// reads and aborts behave like they do in production.
const ARTIFACT_SIZE = 512 * 1024

let distDir: string
let server: http.Server
let baseUrl: string
let artifact: Buffer

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function request (
  urlPath: string,
  options: { headers?: Record<string, string>, method?: string } = {}
): Promise<Res> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${urlPath}`,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        const done = (): void => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        }
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', done)
        // The server destroys the socket when a read fails after headers were sent.
        res.on('aborted', done)
        res.on('error', done)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-server-'))

  artifact = Buffer.alloc(ARTIFACT_SIZE)
  for (let i = 0; i < ARTIFACT_SIZE; i++) artifact[i] = i % 251
  fs.writeFileSync(path.join(distDir, 'Platform-windows-0.9.0-x64.exe'), artifact)
  fs.writeFileSync(path.join(distDir, 'Platform-windows-0.9.0-x64.exe.blockmap'), Buffer.from('blockmap'))

  fs.writeFileSync(
    path.join(distDir, 'latest.yml'),
    [
      'version: 0.9.0',
      'files:',
      '  - url: Platform-windows-0.9.0-x64.exe',
      '    sha512: deadbeef',
      `    size: ${ARTIFACT_SIZE}`,
      'path: Platform-windows-0.9.0-x64.exe',
      'sha512: deadbeef',
      "releaseDate: '2026-09-01T00:00:00.000Z'",
      ''
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(distDir, 'latest-mac.yml'),
    [
      'version: 0.9.0',
      'files:',
      '  - url: Platform-macos-0.9.0-arm64.zip',
      '    sha512: cafe',
      '    size: 10',
      'path: Platform-macos-0.9.0-arm64.zip',
      'sha512: cafe',
      "releaseDate: '2026-09-01T00:00:00.000Z'",
      ''
    ].join('\n')
  )

  server = createDistServer(distDir)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(distDir, { recursive: true, force: true })
})

describe('update manifests', () => {
  it('serves the channel manifest electron-updater asks for', async () => {
    const res = await request('/latest.yml')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/yaml')
    expect(res.body.toString()).toContain('version: 0.9.0')
  })

  it('advertises range support on the installer', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-length']).toBe(String(ARTIFACT_SIZE))
  })

  it('404s an unknown channel instead of serving something else', async () => {
    const res = await request('/platform.yml')
    expect(res.status).toBe(404)
  })

  it('rejects directory traversal', async () => {
    const res = await request('/..%2f..%2fetc%2fpasswd')
    expect([403, 404]).toContain(res.status)
  })
})

describe('single range requests', () => {
  it('returns 206 with the requested bytes', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=100-199' } })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 100-199/${ARTIFACT_SIZE}`)
    expect(res.body).toEqual(artifact.subarray(100, 200))
  })

  it('supports open-ended and suffix ranges', async () => {
    const open = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=524188-' } })
    expect(open.status).toBe(206)
    expect(open.body).toEqual(artifact.subarray(524188))

    const suffix = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=-100' } })
    expect(suffix.status).toBe(206)
    expect(suffix.body).toEqual(artifact.subarray(ARTIFACT_SIZE - 100))
  })

  it('416s an unsatisfiable range', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=999999999-' } })
    expect(res.status).toBe(416)
    expect(res.headers['content-range']).toBe(`bytes */${ARTIFACT_SIZE}`)
  })
})

describe('multiple range requests', () => {
  // electron-updater's DifferentialDownloader batches up to 1000 ranges into a
  // single request; a 416 here silently disables differential updates.
  it('returns 206 multipart/byteranges, not 416', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=0-99, 200-299' } })
    expect(res.status).toBe(206)
    expect(res.headers['content-type']).toMatch(/^multipart\/byteranges; boundary=/)
    expect(Number(res.headers['content-length'])).toBe(res.body.length)
  })

  it('lays out parts in the exact order requested', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', {
      headers: { Range: 'bytes=0-9, 1000-1009, 500-509' } // deliberately out of order
    })
    const boundary = /boundary=(\S+)/.exec(String(res.headers['content-type']))?.[1]
    expect(boundary).toBeDefined()

    const parts = splitMultipart(res.body, boundary as string)
    expect(parts).toHaveLength(3)
    expect(parts[0].contentRange).toBe(`bytes 0-9/${ARTIFACT_SIZE}`)
    expect(parts[0].body).toEqual(artifact.subarray(0, 10))
    expect(parts[1].contentRange).toBe(`bytes 1000-1009/${ARTIFACT_SIZE}`)
    expect(parts[1].body).toEqual(artifact.subarray(1000, 1010))
    expect(parts[2].contentRange).toBe(`bytes 500-509/${ARTIFACT_SIZE}`)
    expect(parts[2].body).toEqual(artifact.subarray(500, 510))
  })

  it('handles a batch of many ranges', async () => {
    const ranges: string[] = []
    const expected: Buffer[] = []
    for (let i = 0; i < 200; i++) {
      const start = i * 1024
      const end = start + 63
      ranges.push(`${start}-${end}`)
      expected.push(artifact.subarray(start, end + 1))
    }
    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: `bytes=${ranges.join(', ')}` } })
    expect(res.status).toBe(206)
    const boundary = /boundary=(\S+)/.exec(String(res.headers['content-type']))?.[1] as string
    const parts = splitMultipart(res.body, boundary)
    expect(parts).toHaveLength(200)
    expect(parts.map((p) => p.body)).toEqual(expected)
  })

  it('416s when one range in the batch is unsatisfiable', async () => {
    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=0-99, 999999999-' } })
    expect(res.status).toBe(416)
  })
})

describe('electron-updater DataSplitter compatibility', () => {
  // Parse our response with the very parser electron-updater uses, so an
  // electron-updater upgrade that changes the wire format fails here.
  it('parses a multipart response', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DataSplitter } = require('electron-updater/out/differentialDownloader/DataSplitter')

    const res = await request('/Platform-windows-0.9.0-x64.exe', { headers: { Range: 'bytes=0-99, 4096-4195' } })
    expect(res.status).toBe(206)
    const boundary = /boundary=(\S+)/.exec(String(res.headers['content-type']))?.[1] as string

    const chunks: Buffer[] = []
    const out = { write: (c: Buffer) => chunks.push(Buffer.from(c)), end: () => {} }
    const partIndexToTaskIndex = new Map<number, number>([
      [0, 0],
      [1, 1]
    ])

    await new Promise<void>((resolve, reject) => {
      const splitter = new DataSplitter(
        out,
        { tasks: [{ kind: 0 }, { kind: 0 }], start: 0, end: 2, oldFileFd: -1 },
        partIndexToTaskIndex,
        boundary,
        [100, 100],
        resolve,
        200,
        undefined
      )
      splitter.on('error', reject)
      splitter.end(res.body)
    })

    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([artifact.subarray(0, 100), artifact.subarray(4096, 4196)]))
  })
})

describe('resilience', () => {
  // A read that fails after the response started (EACCES, ENOENT, EMFILE under
  // load) used to surface as an unhandled 'error' and take the whole process
  // down, killing every other in-flight download with it.
  const canTestPermissions = process.getuid === undefined || process.getuid() !== 0
  const maybe = canTestPermissions ? it : it.skip

  maybe('survives a file it cannot open', async () => {
    const unreadable = path.join(distDir, 'unreadable.exe')
    fs.writeFileSync(unreadable, Buffer.alloc(1024))
    fs.chmodSync(unreadable, 0o000)
    try {
      await request('/unreadable.exe').catch(() => undefined)
      // Give the failing stream a tick to emit.
      await new Promise((resolve) => setTimeout(resolve, 100))

      const res = await request('/latest.yml')
      expect(res.status).toBe(200)
    } finally {
      fs.chmodSync(unreadable, 0o600)
      fs.rmSync(unreadable)
    }
  })

  maybe('survives a multipart request over a file it cannot open', async () => {
    const unreadable = path.join(distDir, 'unreadable-multi.exe')
    fs.writeFileSync(unreadable, Buffer.alloc(4096))
    fs.chmodSync(unreadable, 0o000)
    try {
      await request('/unreadable-multi.exe', { headers: { Range: 'bytes=0-99, 200-299' } }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const res = await request('/latest.yml')
      expect(res.status).toBe(200)
    } finally {
      fs.chmodSync(unreadable, 0o600)
      fs.rmSync(unreadable)
    }
  })

  it('survives a client that aborts mid-download', async () => {
    await new Promise<void>((resolve) => {
      const req = http.get(`${baseUrl}/Platform-windows-0.9.0-x64.exe`, (res) => {
        res.once('data', () => {
          req.destroy()
          setTimeout(resolve, 50)
        })
      })
      req.on('error', () => resolve())
    })

    const res = await request('/latest.yml')
    expect(res.status).toBe(200)
  })
})

describe('downloads listing', () => {
  it('groups manifests by platform', async () => {
    const res = await request('/api/downloads')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body.toString())
    const platforms = (body.platforms as Array<{ platform: string }>).map((p) => p.platform).sort()
    expect(platforms).toEqual(['mac', 'windows'])
  })
})

interface MultipartPart { contentRange: string, body: Buffer }

function splitMultipart (body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []
  let pos = body.indexOf(delimiter)
  while (pos !== -1) {
    const afterDelimiter = pos + delimiter.length
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === '--') break
    const headerEnd = body.indexOf('\r\n\r\n', afterDelimiter)
    const headers = body.subarray(afterDelimiter, headerEnd).toString()
    const bodyStart = headerEnd + 4
    const next = body.indexOf(delimiter, bodyStart)
    // strip the CRLF that precedes the next delimiter
    const bodyEnd = next - 2
    parts.push({
      contentRange: /Content-Range:\s*(.+)/.exec(headers)?.[1].trim() ?? '',
      body: body.subarray(bodyStart, bodyEnd)
    })
    pos = next
  }
  return parts
}
