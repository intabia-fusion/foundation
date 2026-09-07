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
import * as path from 'path'
import * as yaml from 'js-yaml'

export interface ManifestProblem {
  manifest: string
  problem: string
}

export interface VerifyOptions {
  /** Manifest suffixes electron-updater resolves for a channel, per platform. */
  suffixes?: string[]
  /** Hashing every artifact is slow; skip it when only the shape matters. */
  checkHashes?: boolean
}

// Matches what the tag build actually produces (--linux --x64, --windows --x64,
// --macos --x64 --arm64). Add '-linux-arm64' here the day that target is built,
// otherwise every build fails on a manifest nobody generates.
const DEFAULT_SUFFIXES = ['', '-mac', '-linux']

/** Streamed so a 240MB artifact never lands in memory in one piece. */
function sha512 (file: string): string {
  const hash = crypto.createHash('sha512')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let read = fs.readSync(fd, buf, 0, buf.length, null)
    while (read > 0) {
      hash.update(buf.subarray(0, read))
      read = fs.readSync(fd, buf, 0, buf.length, null)
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('base64')
}

/**
 * Validate the update manifests electron-builder produced. A manifest that
 * parses but points at a missing file or carries a stale checksum leaves the app
 * downloading an update it can never install, which looks exactly like the
 * update system being "flaky".
 */
export function verifyManifests (dir: string, channel: string, options: VerifyOptions = {}): ManifestProblem[] {
  const suffixes = options.suffixes ?? DEFAULT_SUFFIXES
  const checkHashes = options.checkHashes ?? true
  const problems: ManifestProblem[] = []
  const add = (manifest: string, problem: string): void => {
    problems.push({ manifest, problem })
  }

  for (const suffix of suffixes) {
    const name = `${channel}${suffix}.yml`
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      add(name, 'missing: electron-updater resolves this file for the configured channel')
      continue
    }

    let parsed: Record<string, unknown>
    try {
      parsed = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch (err) {
      add(name, `not valid YAML: ${String(err)}`)
      continue
    }
    if (parsed === null || typeof parsed !== 'object') {
      add(name, 'empty or not a mapping')
      continue
    }

    if (typeof parsed.version !== 'string' || parsed.version === '') {
      add(name, 'no version')
    }
    if (typeof parsed.path !== 'string' || parsed.path === '') {
      add(name, 'no path: the updater has no artifact to download')
    }
    if (typeof parsed.sha512 !== 'string' || parsed.sha512 === '') {
      add(name, 'no top-level sha512')
    }

    const files = parsed.files
    if (!Array.isArray(files) || files.length === 0) {
      add(name, 'no files entry')
      continue
    }

    const urls: string[] = []
    for (const entry of files as Array<Record<string, unknown>>) {
      const url = entry?.url
      if (typeof url !== 'string' || url === '') {
        add(name, 'file entry without url')
        continue
      }
      urls.push(url)

      const artifact = path.join(dir, url)
      if (!fs.existsSync(artifact)) {
        add(name, `${url}: referenced but not present in ${dir}`)
        continue
      }

      const stats = fs.statSync(artifact)
      if (typeof entry.size === 'number' && entry.size !== stats.size) {
        add(name, `${url}: size ${String(entry.size)} in manifest, ${stats.size} on disk`)
      }
      if (typeof entry.sha512 !== 'string' || entry.sha512 === '') {
        add(name, `${url}: no sha512`)
      } else if (checkHashes && entry.sha512 !== sha512(artifact)) {
        add(name, `${url}: sha512 does not match the file - the update will fail verification`)
      }
    }

    if (typeof parsed.path === 'string' && !urls.includes(parsed.path)) {
      add(name, `path '${parsed.path}' is not listed in files`)
    }
  }

  return problems
}
