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

// Stub heavy deps pulled in transitively by service.ts, unrelated to backoff logic.
import { WorkspaceWorker, type WorkspaceOptions } from '../service'
import type { MeasureContext } from '@hcengineering/core'

jest.mock('@hcengineering/postgres', () => ({
  createPostgreeDestroyAdapter: jest.fn(),
  createPostgresAdapter: jest.fn(),
  createPostgresTxAdapter: jest.fn(),
  setDBExtraOptions: jest.fn(),
  shutdownPostgres: jest.fn()
}))
jest.mock('@hcengineering/server-pipeline', () => ({
  createBackupPipeline: jest.fn(),
  getConfig: jest.fn(),
  getWorkspaceDestroyAdapter: jest.fn(),
  registerAdapterFactory: jest.fn(),
  registerDestroyFactory: jest.fn(),
  registerServerPlugins: jest.fn(),
  registerStringLoaders: jest.fn(),
  registerTxAdapterFactory: jest.fn()
}))
jest.mock('@hcengineering/server-backup', () => ({
  doBackupWorkspace: jest.fn(),
  doRestoreWorkspace: jest.fn()
}))
jest.mock('@hcengineering/server-storage', () => ({
  buildStorageFromConfig: jest.fn(),
  storageConfigFromEnv: jest.fn()
}))
jest.mock('@hcengineering/server-client', () => ({
  getTransactorEndpoint: jest.fn(),
  withRetryConnUntilSuccess: jest.fn((f: any) => f),
  withRetryConnUntilTimeout: jest.fn()
}))
jest.mock('@hcengineering/account-client', () => ({
  getClient: jest.fn()
}))
jest.mock('@hcengineering/server-token', () => ({
  generateToken: jest.fn().mockReturnValue('token')
}))
jest.mock('@hcengineering/server-tool', () => ({
  FileModelLogger: jest.fn(),
  prepareTools: jest.fn()
}))

function createWorker (): WorkspaceWorker {
  return new WorkspaceWorker(
    {} as any,
    { major: 0, minor: 7, patch: 0 },
    [],
    [],
    '',
    1,
    'all',
    {} as any,
    undefined,
    '',
    ''
  )
}

const opt = { waitTimeout: 5000, maxWaitTimeout: 60000 } as unknown as WorkspaceOptions
const ctx = { info: jest.fn(), error: jest.fn() } as unknown as MeasureContext

describe('WorkspaceWorker backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('returns waitTimeout while lastActivity is recent', () => {
    const worker = createWorker()
    worker.lastActivity = Date.now()
    expect(worker.nextSleepMs(opt)).toBe(5000)
    expect(worker.nextSleepMs(opt)).toBe(5000)
  })

  it('doubles the delay with cap once lastActivity is stale', () => {
    const worker = createWorker()
    worker.lastActivity = Date.now() - 31000
    expect(worker.nextSleepMs(opt)).toBe(5000)
    expect(worker.nextSleepMs(opt)).toBe(10000)
    expect(worker.nextSleepMs(opt)).toBe(20000)
    expect(worker.nextSleepMs(opt)).toBe(40000)
    expect(worker.nextSleepMs(opt)).toBe(60000)
    expect(worker.nextSleepMs(opt)).toBe(60000)
  })

  it('resolves immediately on wakeup and resets backoff', async () => {
    const worker = createWorker()
    worker.lastActivity = Date.now() - 31000

    const sleepPromise = (worker as any).doSleep(ctx, opt)
    worker.wakeup()
    await sleepPromise

    worker.lastActivity = Date.now() - 31000
    expect(worker.nextSleepMs(opt)).toBe(5000)
  })

  it('resolves on timer when not woken up, and restores defaultWakeup', async () => {
    const worker = createWorker()
    worker.lastActivity = Date.now()

    const sleepPromise = (worker as any).doSleep(ctx, opt)
    await jest.advanceTimersByTimeAsync(5000 * 1.2 + 1)
    await sleepPromise

    expect(worker.wakeup).toBe(worker.defaultWakeup)
  })
})

describe('WorkspaceWorker main loop sleep/wakeup', () => {
  const loopCtx = {
    info: jest.fn(),
    error: jest.fn(),
    with: jest.fn((_name: string, _params: any, f: any) => f(loopCtx))
  } as unknown as MeasureContext

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  async function startIdleWorker (): Promise<{
    worker: WorkspaceWorker
    getPendingWorkspace: jest.Mock
    stop: () => Promise<void>
  }> {
    const { getClient } = jest.requireMock('@hcengineering/account-client')
    const getPendingWorkspace = jest.fn().mockResolvedValue(null)
    getClient.mockReturnValue({
      workerHandshake: jest.fn().mockResolvedValue(undefined),
      getPendingWorkspace
    })

    const worker = createWorker()
    let canceled = false
    const done = worker.start(loopCtx, opt, () => canceled)
    // let the handshake + first poll settle
    await jest.advanceTimersByTimeAsync(0)

    return {
      worker,
      getPendingWorkspace,
      stop: async () => {
        canceled = true
        worker.wakeup()
        await jest.advanceTimersByTimeAsync(0)
        await done
      }
    }
  }

  it('polls once and goes to sleep when there is no work', async () => {
    const { getPendingWorkspace, stop } = await startIdleWorker()

    expect(getPendingWorkspace).toHaveBeenCalledTimes(1)
    // still sleeping: time below waitTimeout must not produce new polls
    await jest.advanceTimersByTimeAsync(4000)
    expect(getPendingWorkspace).toHaveBeenCalledTimes(1)

    await stop()
  })

  it('wakeup event interrupts the sleep and re-polls immediately', async () => {
    const { worker, getPendingWorkspace, stop } = await startIdleWorker()
    expect(getPendingWorkspace).toHaveBeenCalledTimes(1)

    worker.wakeup()
    // no timer advance needed - wakeup resolves the sleep promise directly
    await jest.advanceTimersByTimeAsync(0)
    expect(getPendingWorkspace).toHaveBeenCalledTimes(2)

    await stop()
  })

  it('polling backstop still fires without wakeup', async () => {
    const { getPendingWorkspace, stop } = await startIdleWorker()
    expect(getPendingWorkspace).toHaveBeenCalledTimes(1)

    // waitTimeout with max jitter is 5000 * 1.2
    await jest.advanceTimersByTimeAsync(5000 * 1.2 + 1)
    expect(getPendingWorkspace).toHaveBeenCalledTimes(2)

    await stop()
  })
})
