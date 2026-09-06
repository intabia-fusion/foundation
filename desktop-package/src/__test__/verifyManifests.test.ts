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

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { verifyManifests } from '../verifyManifests'

let dir: string

function sha512 (buf: Buffer): string {
  return crypto.createHash('sha512').update(buf).digest('base64')
}

function writeArtifact (name: string, content = 'installer-bytes'): { size: number, sha512: string } {
  const buf = Buffer.from(content)
  fs.writeFileSync(path.join(dir, name), buf)
  return { size: buf.length, sha512: sha512(buf) }
}

function writeManifest (name: string, body: Record<string, unknown>): void {
  const files = (body.files as Array<Record<string, unknown>>) ?? []
  const lines = [
    `version: ${String(body.version)}`,
    'files:',
    ...files.flatMap((f) => [
      `  - url: ${String(f.url)}`,
      `    sha512: ${String(f.sha512)}`,
      `    size: ${String(f.size)}`
    ]),
    `path: ${String(body.path)}`,
    `sha512: ${String(body.sha512)}`
  ]
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n')
}

function writeGoodChannel (channel: string): void {
  for (const [suffix, artifact] of [
    ['', 'Platform-windows-0.9.0-x64.exe'],
    ['-mac', 'Platform-macos-0.9.0-arm64.zip'],
    ['-linux', 'Platform-linux-0.9.0-x86_64.AppImage']
  ]) {
    const info = writeArtifact(artifact, `bytes-of-${artifact}`)
    writeManifest(`${channel}${suffix}.yml`, {
      version: '0.9.0',
      files: [{ url: artifact, sha512: info.sha512, size: info.size }],
      path: artifact,
      sha512: info.sha512
    })
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifests-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

it('accepts a complete set of manifests', () => {
  writeGoodChannel('latest')
  expect(verifyManifests(dir, 'latest')).toEqual([])
})

it('reports a channel that was never published', () => {
  writeGoodChannel('latest')
  const problems = verifyManifests(dir, 'platform')
  expect(problems).toHaveLength(3)
  expect(problems.every((p) => p.problem.startsWith('missing'))).toBe(true)
})

it('reports a missing per-platform manifest', () => {
  writeGoodChannel('latest')
  fs.rmSync(path.join(dir, 'latest-mac.yml'))
  expect(verifyManifests(dir, 'latest')).toEqual([
    { manifest: 'latest-mac.yml', problem: expect.stringContaining('missing') }
  ])
})

it('reports an artifact the manifest names but the build did not produce', () => {
  writeGoodChannel('latest')
  fs.rmSync(path.join(dir, 'Platform-windows-0.9.0-x64.exe'))
  const problems = verifyManifests(dir, 'latest')
  expect(problems).toEqual([
    { manifest: 'latest.yml', problem: expect.stringContaining('referenced but not present') }
  ])
})

it('reports a checksum that does not match the artifact', () => {
  writeGoodChannel('latest')
  fs.writeFileSync(path.join(dir, 'Platform-windows-0.9.0-x64.exe'), 'tampered-bytes-of-different-length')
  const problems = verifyManifests(dir, 'latest').map((p) => p.problem)
  expect(problems).toContainEqual(expect.stringContaining('sha512 does not match'))
})

it('reports a path that is not among the listed files', () => {
  writeGoodChannel('latest')
  const info = writeArtifact('Platform-windows-0.9.0-x64.exe', 'bytes-of-Platform-windows-0.9.0-x64.exe')
  writeManifest('latest.yml', {
    version: '0.9.0',
    files: [{ url: 'Platform-windows-0.9.0-x64.exe', sha512: info.sha512, size: info.size }],
    path: 'Platform-windows-0.9.0-x64-other.exe',
    sha512: info.sha512
  })
  const problems = verifyManifests(dir, 'latest').map((p) => p.problem)
  expect(problems).toContainEqual(expect.stringContaining('is not listed in files'))
})

it('reports an empty manifest', () => {
  writeGoodChannel('latest')
  fs.writeFileSync(path.join(dir, 'latest.yml'), '')
  expect(verifyManifests(dir, 'latest')).toEqual([
    { manifest: 'latest.yml', problem: expect.stringMatching(/empty|not valid YAML/) }
  ])
})

it('skips hashing when asked', () => {
  writeGoodChannel('latest')
  fs.writeFileSync(path.join(dir, 'Platform-windows-0.9.0-x64.exe'), 'bytes-of-Platform-windows-0.9.0-x64.ex!')
  expect(verifyManifests(dir, 'latest', { checkHashes: false })).toEqual([])
})
