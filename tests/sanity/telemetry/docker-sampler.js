#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// Per-container CPU/memory/network from the Docker API into NDJSON. Stop with SIGINT/SIGTERM.
//
//   node telemetry/docker-sampler.js --out <file> [--interval 1000] [--filter sanity-]
//
// one-shot returns in ~4ms with empty precpu, so CPU deltas are computed between our own ticks.

const http = require('http')
const fs = require('fs')
const path = require('path')

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

async function dockerGet (urlPath) {
  return await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: urlPath, timeout: 10000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`bad json from ${urlPath}: ${String(err)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`timeout on ${urlPath}`))
    })
    req.end()
  })
}

// Docker reports counters, not rates - keep the previous tick and emit deltas.
const previous = new Map()

// `one-shot=true` leaves stats.name empty on dockerd 28 (it is filled on Docker Desktop), so the
// name comes from /containers/json instead - without it every container shares one delta bucket.
function sample (stats, now, name) {
  const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage ?? 0
  const onlineCpus = stats.cpu_stats?.online_cpus ?? 0
  const mem = stats.memory_stats ?? {}
  // `usage` includes page cache; docker stats subtracts inactive_file.
  const memUsage = (mem.usage ?? 0) - (mem.stats?.inactive_file ?? 0)
  let rx = 0
  let tx = 0
  for (const net of Object.values(stats.networks ?? {})) {
    rx += net.rx_bytes ?? 0
    tx += net.tx_bytes ?? 0
  }

  let diskRead = 0
  let diskWrite = 0
  for (const e of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (e.op === 'read' || e.op === 'Read') diskRead += e.value ?? 0
    if (e.op === 'write' || e.op === 'Write') diskWrite += e.value ?? 0
  }

  const prev = previous.get(name)
  previous.set(name, { now, cpuTotal, rx, tx, diskRead, diskWrite })
  if (prev === undefined) return undefined

  const wallNs = (now - prev.now) * 1e6
  // total_usage is ns across all cores: this is "cores busy" x100.
  const cpuPercent = wallNs > 0 ? ((cpuTotal - prev.cpuTotal) / wallNs) * 100 : 0
  return {
    ts: now,
    name,
    cpu: Math.round(cpuPercent * 10) / 10,
    cpus: onlineCpus,
    mem: memUsage,
    memLimit: mem.limit ?? 0,
    rx: rx - prev.rx,
    tx: tx - prev.tx,
    dr: diskRead - prev.diskRead,
    dw: diskWrite - prev.diskWrite
  }
}

const nameOf = (c) => ((c.Names ?? [])[0] ?? c.Id).replace(/^\//, '')

async function main () {
  const out = arg('out', 'docker.ndjson')
  const interval = Number(arg('interval', '1000'))
  const filter = arg('filter', 'sanity-')

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  const stream = fs.createWriteStream(out, { flags: 'a' })

  const containers = (await dockerGet('/containers/json')).filter((c) =>
    (c.Names ?? []).some((n) => n.replace(/^\//, '').startsWith(filter))
  )
  if (containers.length === 0) {
    console.error(`[telemetry] no containers matching ${JSON.stringify(filter)}, nothing to sample`)
    process.exit(1)
  }
  console.error(`[telemetry] sampling ${containers.length} containers every ${interval}ms -> ${out}`)

  let stopping = false
  let ticks = 0
  const overhead = []

  const tick = async () => {
    if (stopping) return
    const started = Date.now()
    const results = await Promise.all(
      containers.map(async (c) =>
        await dockerGet(`/containers/${c.Id}/stats?stream=false&one-shot=true`).catch(() => undefined)
      )
    )
    const now = Date.now()
    let lines = ''
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) continue
      const row = sample(results[i], now, nameOf(containers[i]))
      if (row !== undefined) lines += JSON.stringify(row) + '\n'
    }
    if (lines !== '') stream.write(lines)
    ticks++
    overhead.push(Date.now() - started)
  }

  const timer = setInterval(() => {
    void tick()
  }, interval)
  await tick()

  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    const avg = overhead.length > 0 ? overhead.reduce((a, b) => a + b, 0) / overhead.length : 0
    console.error(`[telemetry] ${ticks} ticks, avg collection ${avg.toFixed(0)}ms`)
    stream.end(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

void main().catch((err) => {
  console.error(`[telemetry] sampler failed: ${String(err)}`)
  process.exit(1)
})
