/**
  Copyright © 2026 Intabia Fusion.
  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  See https://www.eclipse.org/legal/epl-2.0
*/

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const utils = require('../libs/utils')

// Real `vm_stat` output on Apple Silicon: the page size is 16384, not the 4096 the
// parser used to assume, so available memory was under-reported by a factor of four.
const VM_STAT_ARM64 = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               42000.
Pages active:                            900000.
Pages inactive:                           58000.
Pages speculative:                         3000.
Pages wired down:                        300000.
`

const VM_STAT_X86 = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              168000.
Pages active:                            900000.
Pages inactive:                          232000.
`

const MEMINFO = `MemTotal:       65805864 kB
MemFree:         2033120 kB
MemAvailable:   41943040 kB
Buffers:          123456 kB
`

describe('memory probes', () => {
  test('vm_stat page size is read from the header, not assumed', () => {
    // (42000 + 58000) pages * 16384 B = 1562.5 MiB
    assert.equal(utils.parseDarwinVmStat(VM_STAT_ARM64), 1563)
  })

  test('vm_stat still parses the 4 KiB page size', () => {
    // (168000 + 232000) pages * 4096 B = 1562.5 MiB
    assert.equal(utils.parseDarwinVmStat(VM_STAT_X86), 1563)
  })

  test('unparseable vm_stat output yields null rather than a wrong number', () => {
    assert.equal(utils.parseDarwinVmStat('nonsense'), null)
  })

  // Regression: utils.js destructured readFileSync from child_process, so this branch
  // always threw and silently fell back to os.freemem().
  test('MemAvailable is read from /proc/meminfo', () => {
    assert.equal(utils.parseLinuxMemInfo(MEMINFO), 40960)
  })

  test('meminfo without MemAvailable yields null', () => {
    assert.equal(utils.parseLinuxMemInfo('MemTotal: 100 kB\n'), null)
  })

  test('getAvailableMemoryMB reports a plausible figure', () => {
    const mb = utils.getAvailableMemoryMB()
    assert.ok(mb > 0, 'must be positive')
    assert.ok(mb <= require('node:os').totalmem() / 1024 / 1024, 'must not exceed total RAM')
  })
})

describe('getOptimalWorkerCount', () => {
  const probe = (requested, taskType, availableMemoryMB, cpuCount = 16) =>
    utils.getOptimalWorkerCount(requested, taskType, { availableMemoryMB, cpuCount })

  // Regression: a minWorkers floor of max(2, cpu/2) overrode the memory cap, so a machine
  // with 2 GB free still got 6 TypeScript workers and went OOM.
  test('never exceeds what available memory allows', () => {
    const r = probe(16, 'typescript', 2000)
    assert.ok(r.workers <= 2, `expected <= 2 workers for 2000MB, got ${r.workers}`)
  })

  test('reports limitedByMemory only when memory actually capped the count', () => {
    const tight = probe(16, 'typescript', 2000)
    assert.equal(tight.limitedByMemory, true)

    const roomy = probe(4, 'typescript', 64000)
    assert.equal(roomy.workers, 4)
    assert.equal(roomy.limitedByMemory, false)
  })

  test('never returns fewer than one worker', () => {
    assert.equal(probe(8, 'typescript', 10).workers, 1)
  })

  test('honours an explicitly lower request', () => {
    assert.equal(probe(1, 'typescript', 64000).workers, 1)
  })

  test('caps TypeScript workers even on a large machine', () => {
    assert.ok(probe(64, 'typescript', 512000, 64).workers <= 6)
  })

  test('never exceeds the CPU count', () => {
    assert.ok(probe(64, 'bundle', 512000, 8).workers <= 8)
  })
})
