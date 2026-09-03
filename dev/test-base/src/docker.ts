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

import { spawn } from 'child_process'
import { connect } from 'net'
import { action, log } from './log'

/**
 * @public
 */
export interface ExecOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Name of the action log file; defaults to the command itself. */
  prefix?: string
}

/**
 * @public
 */
export async function exec (cmd: string, args: string[], opts: ExecOptions): Promise<void> {
  await action(opts.prefix ?? `${cmd} ${args.join(' ')}`, async () => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const pipe = (chunk: Buffer): void => {
        process.stdout.write(chunk)
      }
      child.stdout.on('data', pipe)
      child.stderr.on('data', pipe)

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code as number}`))
        }
      })
    })
  })
}

/**
 * @public
 */
export interface ComposeOptions {
  cwd: string
  project: string
  files: string[]
}

function composeArgs (opts: ComposeOptions): string[] {
  return ['compose', ...opts.files.flatMap((f) => ['-f', f]), '-p', opts.project]
}

/**
 * @public
 */
export async function composeDown (opts: ComposeOptions): Promise<void> {
  await exec('docker', [...composeArgs(opts), 'kill'], { cwd: opts.cwd, prefix: 'compose kill' }).catch(() => {})
  await exec('docker', [...composeArgs(opts), 'down', '--volumes', '--remove-orphans'], {
    cwd: opts.cwd,
    prefix: 'compose down'
  })
}

/**
 * @public
 */
export async function composeUp (opts: ComposeOptions): Promise<void> {
  await exec(
    'docker',
    [...composeArgs(opts), 'up', '-d', '--force-recreate', '--renew-anon-volumes', '--remove-orphans'],
    { cwd: opts.cwd, prefix: 'compose up' }
  )
}

/**
 * Polls `check` until it resolves truthy. Every stand step that follows a service start goes through
 * here, so a stand that failed to come up fails with a named step instead of a random timeout later.
 * @public
 */
export async function waitFor (
  name: string,
  check: () => Promise<boolean>,
  timeoutMs = 120000,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string = ''
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        log(`  ready: ${name}`)
        return
      }
    } catch (err: any) {
      lastError = err.message ?? String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${name} is not ready after ${timeoutMs}ms${lastError !== '' ? `: ${lastError}` : ''}`)
}

/**
 * @public
 */
export async function waitTcp (host: string, port: number, timeoutMs?: number): Promise<void> {
  await waitFor(
    `tcp ${host}:${port}`,
    async () =>
      await new Promise<boolean>((resolve) => {
        const socket = connect({ host, port })
        const done = (ok: boolean): void => {
          socket.destroy()
          resolve(ok)
        }
        socket.setTimeout(2000)
        socket.on('connect', () => {
          done(true)
        })
        socket.on('timeout', () => {
          done(false)
        })
        socket.on('error', () => {
          done(false)
        })
      }),
    timeoutMs
  )
}

/**
 * @public
 */
export async function waitHttp (url: string, accept: (status: number, body: string) => boolean): Promise<void> {
  await waitFor(`http ${url}`, async () => {
    const res = await fetch(url)
    return accept(res.status, await res.text())
  })
}

/**
 * @public
 */
export async function waitElastic (port: number): Promise<void> {
  await waitHttp(
    `http://localhost:${port}/_cluster/health`,
    (status, body) => status === 200 && (body.includes('"yellow"') || body.includes('"green"'))
  )
}
