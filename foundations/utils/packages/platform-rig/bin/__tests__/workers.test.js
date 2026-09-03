/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')

const { GenericWorkerPool, getWorkerPool, terminateWorkerPool } = require('../libs/workers')

const WORKER = join(__dirname, 'fixtures', 'echo-worker.js')
const T = 10_000

let pool = null

afterEach(async () => {
  if (pool) {
    await pool.terminate().catch(() => {})
    pool = null
  }
  await terminateWorkerPool().catch(() => {})
})

// Any hang in the pool shows up as this helper rejecting instead of the whole run stalling.
function withDeadline (promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

describe('GenericWorkerPool', () => {
  test('runs queued tasks across workers', { timeout: T }, async () => {
    pool = new GenericWorkerPool(2, WORKER)
    await pool.init()

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(c => pool.runTask('ok', c))
    )
    assert.deepEqual(results.map(r => r.echo).sort(), ['a', 'b', 'c', 'd', 'e'])
  })

  test('a failing task resolves with an Error, it does not reject', { timeout: T }, async () => {
    pool = new GenericWorkerPool(1, WORKER)
    await pool.init()

    const r = await pool.runTask('fail', 'x')
    assert.equal(r.success, false)
    assert.ok(r.error instanceof Error)
  })

  // Regression: _failWorkerTask set workers[i] = null forever. Tasks submitted after the
  // last worker died were pushed to `pending` and never settled — the build hung with no output.
  test('recovers after a worker crashes and keeps serving tasks', { timeout: T }, async () => {
    pool = new GenericWorkerPool(1, WORKER)
    await pool.init()

    const crashed = await withDeadline(pool.runTask('crash', 'boom'), T / 2, 'crash task to settle')
    assert.equal(crashed.success, false)

    const after = await withDeadline(pool.runTask('ok', 'still-alive'), T / 2, 'task after crash')
    assert.equal(after.success, true)
    assert.equal(after.echo, 'still-alive')
  })

  test('recovers after a worker exits with a non-zero code', { timeout: T }, async () => {
    pool = new GenericWorkerPool(1, WORKER)
    await pool.init()

    const died = await withDeadline(pool.runTask('die', 'bye'), T / 2, 'die task to settle')
    assert.equal(died.success, false)

    const after = await withDeadline(pool.runTask('ok', 'respawned'), T / 2, 'task after exit')
    assert.equal(after.success, true)
  })

  // Regression: _recycleWorker put a fresh worker in slot i while the OLD worker's 'exit'
  // event (non-zero after terminate()) then ran _failWorkerTask(i) and nulled the NEW one.
  // With format.js's recycleAfter: 2 the pool silently shrank towards zero and then hung.
  test('recycling does not shrink the pool', { timeout: T }, async () => {
    pool = new GenericWorkerPool(2, WORKER, { recycleAfter: 1 })
    await pool.init()

    for (let i = 0; i < 12; i++) {
      const r = await withDeadline(pool.runTask('ok', `t${i}`), T / 2, `task ${i} after recycles`)
      assert.equal(r.success, true, `task ${i} must complete`)
    }
    assert.equal(pool.workers.filter(w => w !== null).length, 2, 'pool must still hold 2 workers')
  })

  test('recycling by memory threshold also keeps the pool intact', { timeout: T }, async () => {
    pool = new GenericWorkerPool(2, WORKER, { recycleMemoryMB: 100 })
    await pool.init()

    for (let i = 0; i < 8; i++) {
      const r = await withDeadline(pool.runTask('heavy', `m${i}`), T / 2, `heavy task ${i}`)
      assert.equal(r.success, true)
    }
    assert.equal(pool.workers.filter(w => w !== null).length, 2)
  })

  test('tasks submitted to a terminated pool settle instead of hanging', { timeout: T }, async () => {
    pool = new GenericWorkerPool(1, WORKER)
    await pool.init()
    await pool.terminate()

    const r = await withDeadline(pool.runTask('ok', 'late'), T / 2, 'task on terminated pool')
    assert.equal(r.success, false)
    pool = null
  })
})

describe('shared validate pool singleton', () => {
  // Regression: compile_all terminated the shared pool after the validate phase but the
  // module-level singleton kept pointing at the dead instance, so the next getWorkerPool()
  // handed back a pool with zero workers and every task hung.
  test('getWorkerPool returns a live pool after terminateWorkerPool', { timeout: T }, async () => {
    const first = await getWorkerPool(1)
    await terminateWorkerPool()

    const second = await getWorkerPool(1)
    assert.notEqual(second, first, 'a terminated pool must not be handed out again')
    assert.equal(second.terminated, false)
    await terminateWorkerPool()
  })
})
