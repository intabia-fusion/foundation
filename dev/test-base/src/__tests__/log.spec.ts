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

import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import type * as logModule from '../log'

describe('action logs', () => {
  const dir = resolve(mkdtempSync(resolve(tmpdir(), 'test-base-')), 'prepare')
  const original = process.stdout.write.bind(process.stdout)
  let printed = ''
  let action: typeof logModule.action
  let parallel: typeof logModule.parallel

  beforeAll(() => {
    // The console spy goes in before log.ts is loaded, so it sits under the stream patch and sees
    // only what the patch lets through - which is what the terminal would show.
    process.stdout.write = ((chunk: any): boolean => {
      printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as any
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const log: typeof logModule = require('../log')
      log.initLogs(dir)
      action = log.action
      parallel = log.parallel
    })
  })

  afterAll(() => {
    process.stdout.write = original as any
  })

  function fileFor (name: string): string {
    const file = readdirSync(dir).find((it) => it.includes(name))
    expect(file).toBeDefined()
    return readFileSync(resolve(dir, file as string), 'utf8')
  }

  it('keeps the output of a successful action out of the console', async () => {
    printed = ''
    await action('quiet-step', async () => {
      process.stdout.write('noisy detail\n')
    })

    expect(fileFor('quiet-step')).toContain('noisy detail')
    expect(printed).not.toContain('noisy detail')
    expect(printed).toContain('quiet-step')
  })

  it('prints the log of a failed action and keeps the file', async () => {
    printed = ''
    await expect(
      action('broken-step', async () => {
        process.stdout.write('why it broke\n')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(fileFor('broken-step')).toContain('why it broke')
    expect(printed).toContain('why it broke')
    expect(printed).toContain('broken-step FAILED')
  })

  it('still routes a write that outlives its action', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let tail: Promise<void> | undefined

    await action('late-step', async () => {
      process.stdout.write('during\n')
      tail = gate.then(() => {
        process.stdout.write('after\n')
      })
    })
    release()
    await tail

    expect(fileFor('late-step')).toContain('during')
    expect(fileFor('late-step')).toContain('after')
  })

  it('rejects only once every started item has settled', async () => {
    const finished: number[] = []
    let active = 0

    await expect(
      parallel([0, 1, 2, 3, 4], 2, async (item) => {
        active++
        await new Promise((resolve) => setTimeout(resolve, item === 0 ? 0 : 20))
        active--
        if (item === 0) throw new Error('boom')
        finished.push(item)
        return item
      })
    ).rejects.toThrow('boom')

    expect(active).toBe(0)
    // Item 1 was already in flight when 0 failed; the rest of the queue is never started.
    expect(finished).toEqual([1])
  })

  it('routes concurrent actions into their own files', async () => {
    await Promise.all([
      action('left-step', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        process.stdout.write('left detail\n')
      }),
      action('right-step', async () => {
        process.stdout.write('right detail\n')
      })
    ])

    expect(fileFor('left-step')).toContain('left detail')
    expect(fileFor('left-step')).not.toContain('right detail')
    expect(fileFor('right-step')).toContain('right detail')
    expect(fileFor('right-step')).not.toContain('left detail')
  })
})
