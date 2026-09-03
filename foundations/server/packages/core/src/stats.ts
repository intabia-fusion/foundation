import type { MeasureContext, Metrics } from '@hcengineering/core'
import { concatLink, MeasureMetricsContext, metricsClean, newMetrics, systemAccountUuid } from '@hcengineering/core'
import { RPCHandler } from '@hcengineering/rpc'
import { generateToken } from '@hcengineering/server-token'
import os from 'os'

export interface MemoryStatistics {
  memoryUsed: number
  memoryTotal: number

  memoryArrayBuffers: number
  memoryRSS: number
  freeMem: number
  totalMem: number

  // Heap at process start; (memoryUsed - memoryBaseline) / workspaces is the honest per-workspace cost.
  memoryBaseline: number
}
export interface CPUStatistics {
  usage: number
  cores: number
}

/**
 * @public
 */
export interface StatisticsElement {
  find: number
  tx: number
}

export interface UserStatistics {
  userId: string
  sessionId: string
  data: any
  mins5: StatisticsElement
  total: StatisticsElement
  current: StatisticsElement
}

export interface WorkspaceStatistics {
  sessions: UserStatistics[]
  workspaceName: string
  wsId: string
  sessionsTotal: number
  clientsTotal: number

  service?: string
}
export interface ServiceStatistics {
  serviceName: string // A service category
  memory: MemoryStatistics
  cpu: CPUStatistics
  stats?: Metrics
  workspaces?: WorkspaceStatistics[]
}

/** Heap at process start: (memoryUsed - memoryBaseline) / workspaces is the honest per-workspace cost. */
export const memoryBaseline = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100

export function getMemoryInfo (): MemoryStatistics {
  const memU = process.memoryUsage()
  return {
    memoryBaseline,
    memoryUsed: Math.round((memU.heapUsed / 1024 / 1024) * 100) / 100,
    memoryRSS: Math.round((memU.rss / 1024 / 1024) * 100) / 100,
    memoryTotal: Math.round((memU.heapTotal / 1024 / 1024) * 100) / 100,
    memoryArrayBuffers: Math.round((memU.arrayBuffers / 1024 / 1024) * 100) / 100,
    freeMem: Math.round((os.freemem() / 1024 / 1024) * 100) / 100,
    totalMem: Math.round((os.totalmem() / 1024 / 1024) * 100) / 100
  }
}

export function getCPUInfo (): CPUStatistics {
  return {
    usage: Math.round(os.loadavg()[0] * 100) / 100,
    cores: os.cpus().length
  }
}

// Fixed tick; the policy from stats only changes which ticks do work, so the timer is set once.
const TICK_INTERVAL = 1000
const METRICS_MIN_SECONDS = 10
const METRICS_MAX_SECONDS = 300
const DEFAULT_METRICS_THRESHOLD = 0.01

function clampSeconds (value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(3600, Math.max(1, Math.round(value)))
}

// Cheap activity probe: metrics.operations only counts its own node, so walk the tree.
function totalOperations (m: Metrics | undefined): number {
  if (m === undefined) return 0
  let total = m.operations
  for (const child of Object.values(m.measurements)) {
    total += totalOperations(child)
  }
  return total
}

// Keeps the service registered while it has nothing new to report.
async function sendHeartbeat (
  statsUrl: string,
  token: string,
  serviceId: string,
  applyRate: (body: any) => void
): Promise<boolean> {
  try {
    const res = await fetch(concatLink(statsUrl, '/api/v1/health') + `/?name=${serviceId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` }
    })
    const body = await res.json()
    applyRate(body)
    return body?.known !== false
  } catch {
    // Best effort: a missed heartbeat only means stats shows us stale for a while.
    return true
  }
}
/**
 * @public
 */
export function initStatisticsContext (
  serviceName: string,
  ops?: {
    logFile?: string
    factory?: () => MeasureContext
    getStats?: () => WorkspaceStatistics[]
    statsUrl?: string
    serviceName?: () => string
  }
): MeasureContext {
  let metricsContext: MeasureContext
  if (ops?.factory !== undefined) {
    metricsContext = ops.factory()
  } else {
    metricsContext = new MeasureMetricsContext(serviceName, {}, {}, newMetrics())
  }

  const statsUrl = ops?.statsUrl ?? process.env.STATS_URL

  let errorToSend = 0

  if (statsUrl !== undefined) {
    metricsContext.info('using stats url', { statsUrl, service: serviceName ?? '' })
    const serviceId = encodeURIComponent(os.hostname() + '-' + serviceName)

    let prev: Promise<void> | Promise<any> | undefined
    const handleError = (err: any): void => {
      errorToSend++
      if (errorToSend % 2 === 0) {
        const code = err?.code ?? err?.cause?.code
        if (code !== 'UND_ERR_SOCKET') {
          metricsContext.warn('Failed to send statistics', {
            service: serviceName,
            statsUrl,
            code,
            message: err?.message,
            causeMessage: err?.cause?.message,
            err
          })
        }
      }
      prev = undefined
    }

    const rpcHandler = new RPCHandler()

    // stats returns the cadence it wants from us; an old one returns nothing and this stays put.
    // stats owns the cadence, in seconds: check no more often than min, force a push at max even
    // when idle, push early when activity moved by more than threshold.
    let minSeconds = METRICS_MIN_SECONDS
    let maxSeconds = METRICS_MAX_SECONDS
    let threshold = DEFAULT_METRICS_THRESHOLD
    let lastCheck = 0
    // stats bumps this on wipe; services send cumulative trees, so they have to clear their own.
    let seenReset = -1
    // No exp on a service token, so mint it once instead of on every push and heartbeat.
    const statsToken = generateToken(systemAccountUuid, undefined, { service: serviceName })
    let lastOperations = -1
    let lastContact = 0
    let lastFullPush = 0
    // Liveness probe: either a full push or this, every 10s.
    const HEARTBEAT_INTERVAL = 10000

    // Counters are zeroed in place and the structure is kept: long-lived child contexts (the
    // collector's `client` node, for one) hold references into the tree, and dropping a node
    // leaves them writing into an orphan forever.
    const zeroTree = (m: Metrics): void => {
      m.operations = 0
      m.value = 0
      m.topResult = undefined
      for (const bucket of Object.values(m.params)) {
        for (const data of Object.values(bucket)) {
          data.operations = 0
          data.value = 0
          data.topResult = undefined
        }
      }
      for (const child of Object.values(m.measurements)) {
        zeroTree(child)
      }
    }

    const resetMetrics = (): void => {
      if (metricsContext.metrics === undefined) return
      zeroTree(metricsContext.metrics)
      lastOperations = -1
    }

    const applyRate = (body: any): void => {
      if (typeof body?.reset === 'number') {
        if (seenReset >= 0 && body.reset > seenReset) {
          resetMetrics()
        }
        seenReset = body.reset
      }
      minSeconds = clampSeconds(body?.minInterval, minSeconds)
      maxSeconds = Math.max(minSeconds, clampSeconds(body?.maxInterval, maxSeconds))
      if (typeof body?.threshold === 'number' && Number.isFinite(body.threshold)) {
        threshold = body.threshold
      }
    }

    const push = (): void => {
      try {
        if (prev !== undefined) {
          // In case of high load, skip
          return
        }
        if (statsUrl !== undefined) {
          const now = Date.now()
          if (now - lastCheck < minSeconds * 1000) {
            return
          }
          lastCheck = now
          const operations = totalOperations(metricsContext.metrics)
          const moved =
            lastOperations < 0 || Math.abs(operations - lastOperations) > Math.max(1, lastOperations * threshold)
          if (!moved && now - lastFullPush < maxSeconds * 1000) {
            // Nothing to report yet - only prove we are alive, and only if a push has not.
            if (lastContact !== 0 && now - lastContact >= HEARTBEAT_INTERVAL) {
              lastContact = now
              void sendHeartbeat(statsUrl, statsToken, serviceId, applyRate).then((known) => {
                if (!known) {
                  lastOperations = -1
                }
              })
            }
            return
          }
          lastOperations = operations
          lastContact = now
          lastFullPush = now
          const data: ServiceStatistics = {
            serviceName: ops?.serviceName?.() ?? serviceName,
            cpu: getCPUInfo(),
            memory: getMemoryInfo(),
            stats: metricsContext.metrics !== undefined ? metricsClean(metricsContext.metrics) : undefined,
            workspaces: ops?.getStats?.()
          }

          const statData = rpcHandler.serialize({ method: 'data', params: [data] }, true)

          void metricsContext.with(
            'sendStatistics',
            {},
            async (ctx) => {
              prev = fetch(concatLink(statsUrl, '/api/v1/statistics') + `/?name=${serviceId}`, {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/octet-stream',
                  authorization: `Bearer ${statsToken}`
                },
                body: statData
              })
                .then(async (res) => {
                  try {
                    applyRate(await res.json())
                  } catch {
                    // Older stats: empty body, keep the built-in interval.
                  }
                })
                .finally(() => {
                  prev = undefined
                })
                .catch(handleError)
            },
            undefined,
            { span: 'disable' }
          )
        }
      } catch (err: any) {
        handleError(err)
      }
    }

    const intTimer = setInterval(push, TICK_INTERVAL)

    const closeTimer = (): void => {
      clearInterval(intTimer)
    }
    process.on('SIGINT', closeTimer)
    process.on('SIGTERM', closeTimer)
  }

  return metricsContext
}
