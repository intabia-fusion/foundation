/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const utils = require('../libs/utils')

describe('cgroup memory limit parsing', () => {
  // In a container os.totalmem() reports the HOST's RAM. Sizing pools from it is what
  // gets a CI job OOM-killed, so the cgroup limit has to win.
  test('reads a cgroup v2 byte limit', () => {
    assert.equal(utils.parseCgroupBytes('4294967296\n'), 4096)
  })

  test('treats "max" as no limit', () => {
    assert.equal(utils.parseCgroupBytes('max\n'), null)
  })

  test('treats the v1 unlimited sentinel as no limit', () => {
    // cgroup v1 writes a huge number instead of "max".
    assert.equal(utils.parseCgroupBytes('9223372036854771712'), null)
  })

  test('rejects junk and empty files', () => {
    assert.equal(utils.parseCgroupBytes(''), null)
    assert.equal(utils.parseCgroupBytes('not-a-number'), null)
    assert.equal(utils.parseCgroupBytes('0'), null)
    assert.equal(utils.parseCgroupBytes(null), null)
  })
})

describe('cgroup cpu quota parsing', () => {
  test('reads a v2 quota/period pair', () => {
    assert.equal(utils.parseCgroupCpuMax('200000 100000'), 2)
  })

  test('rounds a fractional quota up to a whole core', () => {
    assert.equal(utils.parseCgroupCpuMax('150000 100000'), 2)
    assert.equal(utils.parseCgroupCpuMax('50000 100000'), 1)
  })

  test('treats "max" as unlimited', () => {
    assert.equal(utils.parseCgroupCpuMax('max 100000'), null)
  })

  test('falls back to the default period when only a quota is given', () => {
    assert.equal(utils.parseCgroupCpuMax('400000'), 4)
  })

  test('rejects junk', () => {
    assert.equal(utils.parseCgroupCpuMax('-1 100000'), null)
    assert.equal(utils.parseCgroupCpuMax('abc def'), null)
    assert.equal(utils.parseCgroupCpuMax(null), null)
  })

  test('getUsableCpuCount returns at least one CPU', () => {
    assert.ok(utils.getUsableCpuCount() >= 1)
  })
})

describe('worker sizing stays inside the memory budget', () => {
  const PHASES = ['typescript', 'svelte-check', 'format', 'lint', 'bundle', 'default']
  const BOXES = [
    { name: 'GH ubuntu-latest', availableMemoryMB: 14000, cpuCount: 4 },
    { name: 'GH large runner', availableMemoryMB: 28000, cpuCount: 8 },
    { name: '4GB container', availableMemoryMB: 4000, cpuCount: 2 },
    { name: '2GB container', availableMemoryMB: 2000, cpuCount: 2 },
    { name: '1GB container', availableMemoryMB: 1000, cpuCount: 1 },
    { name: '512MB container', availableMemoryMB: 512, cpuCount: 1 }
  ]

  for (const box of BOXES) {
    for (const phase of PHASES) {
      test(`${phase} on ${box.name} never exceeds its budget`, () => {
        const r = utils.getOptimalWorkerCount(16, phase, box)
        assert.ok(r.workers >= 1, 'at least one worker')
        assert.ok(r.workers <= box.cpuCount, `workers ${r.workers} must not exceed ${box.cpuCount} CPUs`)
        assert.ok(
          r.workers * r.heapMB <= r.budgetMB,
          `${r.workers} x ${r.heapMB}MB = ${r.workers * r.heapMB}MB exceeds budget ${r.budgetMB}MB`
        )
      })
    }
  }

  test('budget leaves headroom below what is available', () => {
    const r = utils.getOptimalWorkerCount(4, 'typescript', { availableMemoryMB: 10000, cpuCount: 8 })
    assert.ok(r.budgetMB < 10000, 'must not claim every free megabyte')
    assert.ok(r.budgetMB > 7000, 'but must not be needlessly timid')
  })

  test('flags when a worker gets less heap than the heaviest package needs', () => {
    const tight = utils.getOptimalWorkerCount(4, 'svelte-check', { availableMemoryMB: 1500, cpuCount: 4 })
    assert.equal(tight.belowSafeHeap, true)
    assert.ok(tight.minHeapMB > tight.heapMB)

    const roomy = utils.getOptimalWorkerCount(4, 'svelte-check', { availableMemoryMB: 28000, cpuCount: 8 })
    assert.equal(roomy.belowSafeHeap, false)
  })

  test('a tighter cgroup limit wins over the OS view', () => {
    const big = utils.getOptimalWorkerCount(16, 'typescript', { availableMemoryMB: 64000, cpuCount: 16 })
    const small = utils.getOptimalWorkerCount(16, 'typescript', { availableMemoryMB: 3000, cpuCount: 16 })
    assert.ok(small.workers < big.workers, 'a memory-capped box must run fewer workers')
  })

  test('CPU quota caps workers even with plenty of memory', () => {
    const r = utils.getOptimalWorkerCount(16, 'bundle', { availableMemoryMB: 64000, cpuCount: 2 })
    assert.equal(r.workers, 2)
  })
})
