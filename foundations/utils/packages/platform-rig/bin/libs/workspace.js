/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

const { readFileSync, existsSync, statSync, globSync } = require('fs')
const { join, dirname } = require('path')

let cache = null

function findWorkspaceRoot (startPath = process.cwd()) {
  let current = startPath
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Projects declared in pnpm-workspace.yaml. Entries may be plain paths or globs.
 * @returns {Array<{name: string, path: string, fullPath: string, private: boolean}>}
 */
function listWorkspaceProjects (rootDir = findWorkspaceRoot()) {
  if (rootDir == null) throw new Error('pnpm-workspace.yaml not found')
  const wsPath = join(rootDir, 'pnpm-workspace.yaml')
  const key = `${rootDir}:${statSync(wsPath).mtimeMs}`
  if (cache && cache.key === key) return cache.projects

  const patterns = []
  let inPackages = false
  for (const raw of readFileSync(wsPath, 'utf-8').split('\n')) {
    if (/^packages:\s*$/.test(raw)) { inPackages = true; continue }
    if (!inPackages) continue
    const m = raw.match(/^\s*-\s*['"]?(.+?)['"]?\s*$/)
    if (m) { patterns.push(m[1]); continue }
    if (raw.trim() !== '' && !raw.trimStart().startsWith('#')) inPackages = false
  }

  const folders = new Set()
  for (const pattern of patterns) {
    if (/[*?[]/.test(pattern)) {
      for (const f of globSync(pattern, { cwd: rootDir })) folders.add(f)
    } else {
      folders.add(pattern)
    }
  }

  const projects = []
  for (const folder of [...folders].sort()) {
    const pkgJsonPath = join(rootDir, folder, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    projects.push({ name: pkg.name, path: folder, fullPath: join(rootDir, folder), private: pkg.private === true })
  }

  cache = { key, projects }
  return projects
}

module.exports = { listWorkspaceProjects, findWorkspaceRoot }
