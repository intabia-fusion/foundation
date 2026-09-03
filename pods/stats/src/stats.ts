//
// Copyright © 2024 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.
//

import { Analytics } from '@hcengineering/analytics'
import { metricsAggregate, type MeasureContext, type Metrics } from '@hcengineering/core'
import { setMetadata } from '@hcengineering/platform'
import { RPCHandler } from '@hcengineering/rpc'
import {
  getCPUInfo,
  getMemoryInfo,
  type CPUStatistics,
  type MemoryStatistics,
  type ServiceStatistics,
  type WorkspaceStatistics
} from '@hcengineering/server-core'
import serverToken, { decodeToken, hasAdminSession, isHumanAdmin, type Token } from '@hcengineering/server-token'
import cors from '@koa/cors'
import type { IncomingHttpHeaders } from 'http'
import Koa from 'koa'
import bodyParser from 'koa-body'
import Router from 'koa-router'
import { compress as snappyCompress } from 'snappy'

// Services report every 5s (METRICS_UPDATE_INTERVAL) - 20s means 4 missed reports
const serviceTimeout = 20_000

interface TelemetryPolicy {
  // Seconds.
  minInterval: number
  maxInterval: number
  threshold: number
}

// Seconds. Below 1s stats itself becomes the load; an hour is well past "looks dead".
function clampSeconds (value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(3600, Math.max(1, Math.round(value)))
}

interface ServiceStatisticsEx extends ServiceStatistics {
  lastUpdate: number // Last updated
}

interface AnalyticsEntry {
  service: string
  path: string
  operations: number
  total: number
  avg: number
  top: Array<{ value: number, time?: number, params?: Record<string, any> }>
}

const round2 = (v: number): number => Math.round(v * 100) / 100

const toTop = (t: {
  value: number
  time?: number
  params: Record<string, any>
}): {
  value: number
  time?: number
  params?: Record<string, any>
} => ({ value: round2(t.value), time: t.time !== undefined ? round2(t.time) : undefined, params: t.params })

const buildEntry = (service: string, pathSegs: string[], m: Metrics): AnalyticsEntry => ({
  service,
  path: pathSegs.join('/'),
  operations: m.operations,
  total: round2(m.value),
  avg: round2(m.value / (m.operations > 0 ? m.operations : 1)),
  top: (m.topResult ?? []).slice(0, 3).map(toTop)
})

interface OverviewStatistics {
  memory: MemoryStatistics
  cpu: CPUStatistics
  data: Record<string, Omit<ServiceStatistics, 'stats' | 'workspaces'>>
  usersTotal: number
  connectionsTotal: number

  admin: boolean
  workspaces: WorkspaceStatistics[]
}

const extractAuthorizationToken = (headers: IncomingHttpHeaders): string | undefined => {
  try {
    return headers.authorization?.slice(7) ?? undefined
  } catch {
    return undefined
  }
}

// The CLI reaches stats with a `tool` service token; a human operator needs a fresh `/admin` second
// factor. Tokens come from the Authorization header only - a query string token ends up in proxy logs.
const isStatsAdmin = (payload: Token): boolean =>
  payload.extra?.service === 'tool' || (isHumanAdmin(payload) && hasAdminSession(payload))

/**
 * @public
 */
export function serveStats (ctx: MeasureContext, onClose?: () => void): void {
  const servicePort = parseInt(process.env.PORT ?? '4900')
  ctx.info('Starting stats service')

  const serverSecret = process.env.SERVER_SECRET
  if (serverSecret === undefined) {
    ctx.info('Please provide server secret')
    process.exit(1)
  }

  setMetadata(serverToken.metadata.Secret, serverSecret)
  setMetadata(serverToken.metadata.Service, 'stats')

  const statistics = new Map<string, ServiceStatisticsEx>()

  // Push policy per service, returned on every PUT: tick every min, force a push at max even
  // when idle, push early when activity moved by more than threshold.
  const defaultPolicy: TelemetryPolicy = {
    minInterval: clampSeconds(parseInt(process.env.TELEMETRY_MIN_INTERVAL ?? '10'), 10),
    maxInterval: clampSeconds(parseInt(process.env.TELEMETRY_MAX_INTERVAL ?? '300'), 300),
    threshold: parseFloat(process.env.TELEMETRY_THRESHOLD ?? '0.01')
  }
  const policies = new Map<string, TelemetryPolicy>()
  // Services send cumulative trees, so clearing our copy alone is undone by the next push.
  // The generation travels back on every response; a service that sees a new one resets its own.
  let resetGeneration = 0
  const policyFor = (service: string): TelemetryPolicy => policies.get(service) ?? defaultPolicy

  const isStale = (v: ServiceStatisticsEx): boolean => Date.now() - v.lastUpdate > serviceTimeout

  // Background sweep: dead instances (restarted pods register under a new hostname id)
  // must not linger in the map even when nobody opens the overview.
  const sweepInterval = setInterval(() => {
    for (const [k, v] of statistics.entries()) {
      if (isStale(v)) {
        statistics.delete(k)
      }
    }
  }, serviceTimeout)

  const app = new Koa()
  const router = new Router()

  app.use(
    cors({
      credentials: true,
      exposeHeaders: ['X-Encoding']
    })
  )

  app.use(
    bodyParser({
      jsonLimit: '150mb',
      text: true,
      textLimit: '150mb'
    })
  )

  router.get('/api/v1/overview', (req, res) => {
    try {
      const token = extractAuthorizationToken(req.headers) ?? ''
      const payload = decodeToken(token)
      const admin = isStatsAdmin(payload)
      if (!admin) {
        req.res.setHeader('Content-Type', 'application/json')
        const dta: OverviewStatistics = {
          memory: getMemoryInfo(),
          cpu: getCPUInfo(),
          data: {},
          usersTotal: 0,
          connectionsTotal: 0,
          admin: false,
          workspaces: []
        }
        req.body = dta
        return
      }

      let usersTotal: number = 0
      let connectionsTotal: number = 0

      const allWorkspaces: WorkspaceStatistics[] = []

      const json: Record<string, Omit<ServiceStatistics, 'stats' | 'workspaces'>> = {}
      for (const [k, v] of statistics.entries()) {
        if (isStale(v)) continue
        const { stats: _, workspaces, ...data } = v

        allWorkspaces.push(...(workspaces ?? []))
        if (workspaces !== undefined) {
          for (const ws of workspaces) {
            ws.service = k
            usersTotal += ws.clientsTotal
            connectionsTotal += ws.sessionsTotal
          }
        }
        json[k] = {
          ...data
        }
      }

      const dta: OverviewStatistics = {
        memory: getMemoryInfo(),
        cpu: getCPUInfo(),
        data: json,
        usersTotal,
        connectionsTotal,
        admin: true,
        workspaces: allWorkspaces
      }
      req.body = dta
    } catch (err: any) {
      console.error(err, req.host, req.headers, req.ip)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.get('/api/v1/statistics', (req, res) => {
    try {
      const token = extractAuthorizationToken(req.headers) ?? ''
      const payload = decodeToken(token)
      const admin = isStatsAdmin(payload)
      ctx.info('get stats', { admin, service: req.query.name })
      if (admin) {
        const json = statistics.get((req.query.name as string) ?? '')
        if (json !== undefined && !isStale(json)) {
          req.res.setHeader('Content-Type', 'application/json')
          const result: ServiceStatistics = {
            ...json,
            stats: json.stats !== undefined ? metricsAggregate(json.stats) : undefined
          }
          req.body = result
          return
        }
      }
      const json = {}
      req.res.setHeader('Content-Type', 'application/json')
      req.body = json
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })
  const rpcHandler = new RPCHandler()

  router.put('/api/v1/statistics', async (req, res) => {
    try {
      const token = extractAuthorizationToken(req.headers) ?? ''
      const payload = decodeToken(token)
      const service = payload.extra?.service != null
      const serviceName = (req.query.name as string) ?? ''
      if (service) {
        const contentType = req.headers['content-type']

        if (contentType === 'application/octet-stream') {
          // Read raw body from stream for RPC data
          const chunks: Buffer[] = []
          req.req.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })

          await new Promise<void>((resolve, reject) => {
            req.req.on('end', resolve)
            req.req.on('error', reject)
          })

          const rawBody = Buffer.concat(chunks)

          try {
            const deserialized = rpcHandler.readRequest(rawBody, true)
            if (deserialized.method === 'data') {
              statistics.set(serviceName, {
                ...(deserialized.params?.[0] as ServiceStatistics),
                lastUpdate: Date.now()
              })
            }
          } catch (deserializeErr: any) {
            ctx.error('put stats deserialization error', {
              error: deserializeErr.message,
              rawBodyLength: rawBody.length
            })
            throw deserializeErr
          }
        } else {
          statistics.set(serviceName, {
            ...((req.request as any).body as ServiceStatistics),
            lastUpdate: Date.now()
          })
        }
      }
      // Older services ignore the body and keep their built-in interval.
      req.res.writeHead(200, { 'Content-Type': 'application/json' })
      req.res.end(JSON.stringify({ ...policyFor(serviceName), reset: resetGeneration }))
    } catch (err: any) {
      console.error(err, req.host, req.headers, req.ip)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  // Idle services skip the payload and ping here instead, so they stay out of the stale sweep.
  router.put('/api/v1/health', (req, res) => {
    try {
      const token = (req.query.token as string) ?? extractAuthorizationToken(req.headers)
      const payload = decodeToken(token)
      const serviceName = (req.query.name as string) ?? ''
      const existing = payload.extra?.service != null ? statistics.get(serviceName) : undefined
      if (existing !== undefined) {
        existing.lastUpdate = Date.now()
      }
      // `known: false` after a stats restart tells the service to send the full tree again.
      req.res.writeHead(200, { 'Content-Type': 'application/json' })
      req.res.end(JSON.stringify({ ...policyFor(serviceName), known: existing !== undefined, reset: resetGeneration }))
    } catch (err: any) {
      console.error(err, req.host, req.ip)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.get('/api/v1/analytics', (req, res) => {
    try {
      const token = extractAuthorizationToken(req.headers) ?? ''
      const payload = decodeToken(token)
      if (!isStatsAdmin(payload)) {
        req.res.writeHead(401, {})
        req.res.end()
        return
      }

      const limitRaw = parseInt((req.query.limit as string) ?? '100')
      const limit = Math.min(Math.max(isNaN(limitRaw) ? 100 : limitRaw, 1), 1000)
      const sortKey = ((req.query.sort as string) ?? 'time') as 'time' | 'count' | 'avg'
      if (sortKey !== 'time' && sortKey !== 'count' && sortKey !== 'avg') {
        req.res.writeHead(400, {})
        req.res.end()
        return
      }
      const source = ((req.query.source as string) ?? 'all') as 'all' | 'client' | 'server'
      if (source !== 'all' && source !== 'client' && source !== 'server') {
        req.res.writeHead(400, {})
        req.res.end()
        return
      }

      const entries: AnalyticsEntry[] = []

      const minOps = 10
      // Soft cap on visited nodes - prevents pathologically deep trees from
      // blocking the event loop on a single analytics request.
      const maxVisits = 100_000
      let visited = 0

      const path: string[] = []
      const walk = (service: string, m: Metrics): void => {
        if (visited++ >= maxVisits) return
        const childMeasurements: Array<[string, Metrics]> = []
        for (const e of Object.entries(m.measurements)) {
          if (!e[0].startsWith('#')) childMeasurements.push(e)
        }
        const hasChildMeasurements = childMeasurements.length > 0
        const hasParams = Object.keys(m.params).length > 0
        // True leaf: no child measurements and no params - emit the node itself.
        if (!hasChildMeasurements && !hasParams && m.operations >= minOps) {
          entries.push(buildEntry(service, path, m))
        }
        // Emit param values only when this node has no child measurements.
        // Otherwise the more granular breakdown lives deeper in the tree
        // (e.g. findAll has params.source AND measurements.client-find-all,
        // where client-find-all/findAll/domain=X is the actually useful leaf).
        if (!hasChildMeasurements && hasParams) {
          for (const [pk, pvals] of Object.entries(m.params)) {
            for (const [pv, pdata] of Object.entries(pvals)) {
              if (pdata.operations < minOps) continue
              path.push(`${pk}=${pv}`)
              entries.push({
                service,
                path: path.join('/'),
                operations: pdata.operations,
                total: round2(pdata.value),
                avg: round2(pdata.value / pdata.operations),
                top: (pdata.topResult ?? []).slice(0, 3).map(toTop)
              })
              path.pop()
            }
          }
        }
        for (const [name, child] of childMeasurements) {
          path.push(name)
          walk(service, child)
          path.pop()
        }
      }

      let serviceCount = 0
      for (const [name, svc] of statistics.entries()) {
        if (isStale(svc)) continue
        if (svc.stats === undefined) continue
        serviceCount++
        for (const [op, child] of Object.entries(svc.stats.measurements)) {
          if (op.startsWith('#')) continue
          path.push(op)
          walk(name, child)
          path.pop()
        }
      }

      const filtered = entries.filter((e) => {
        if (source === 'all') return true
        const isClient = e.path === 'client' || e.path.startsWith('client/')
        return source === 'client' ? isClient : !isClient
      })

      filtered.sort((a, b) => {
        if (sortKey === 'count') return b.operations - a.operations
        if (sortKey === 'avg') return b.avg - a.avg
        return b.total - a.total
      })

      req.res.setHeader('Content-Type', 'application/json')
      req.body = {
        entries: filtered.slice(0, limit),
        generatedAt: Date.now(),
        services: serviceCount
      }
    } catch (err: any) {
      Analytics.handleError(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.put('/api/v1/manage', async (req, res) => {
    try {
      const token = extractAuthorizationToken(req.headers) ?? ''
      const payload = decodeToken(token)
      if (!isStatsAdmin(payload)) {
        req.res.writeHead(404, {})
        req.res.end()
        return
      }

      const operation = req.query.operation

      switch (operation) {
        case 'wipe-statistics': {
          statistics.clear()
          resetGeneration++
          req.res.writeHead(200)
          req.res.end()
          return
        }
        case 'set-rate': {
          const base = policyFor((req.query.service as string) ?? '')
          const policy: TelemetryPolicy = {
            minInterval: clampSeconds(parseInt((req.query.min as string) ?? ''), base.minInterval),
            maxInterval: clampSeconds(parseInt((req.query.max as string) ?? ''), base.maxInterval),
            threshold: parseFloat((req.query.threshold as string) ?? '')
          }
          if (!Number.isFinite(policy.threshold)) policy.threshold = base.threshold
          policy.maxInterval = Math.max(policy.minInterval, policy.maxInterval)
          const service = req.query.service as string
          if (service === undefined || service === '' || service === '*') {
            policies.clear()
            for (const name of statistics.keys()) {
              policies.set(name, policy)
            }
          } else {
            policies.set(service, policy)
          }
          req.res.writeHead(200, { 'Content-Type': 'application/json' })
          req.res.end(JSON.stringify({ service: service ?? '*', ...policy }))
          return
        }
        case 'get-rates': {
          req.res.writeHead(200, { 'Content-Type': 'application/json' })
          req.res.end(JSON.stringify({ default: defaultPolicy, services: Object.fromEntries(policies) }))
          return
        }
      }

      req.res.writeHead(404, {})
      req.res.end()
    } catch (err: any) {
      Analytics.handleError(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  // Optional snappy compression for JSON responses. Browsers cannot set the
  // standard Accept-Encoding header via fetch(), so we use X-Accept-Encoding.
  // Skip below 1KB - overhead exceeds savings.
  app.use(async (ctx, next) => {
    await next()
    const accept = (ctx.headers['x-accept-encoding'] ?? '').toString().toLowerCase()
    if (!accept.includes('snappy')) return
    const contentType = (ctx.response.get('Content-Type') ?? '').toLowerCase()
    if (!contentType.includes('application/json')) return
    if (ctx.body == null) return
    const json = typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body)
    const buf = Buffer.from(json, 'utf8')
    if (buf.length < 1024) {
      ctx.body = json
      return
    }
    const compressed = await snappyCompress(buf)
    // Custom header avoids browser auto-decoding ambiguity with
    // Content-Encoding values it does not recognise.
    ctx.set('X-Encoding', 'snappy')
    ctx.set('Content-Type', 'application/octet-stream')
    ctx.body = compressed
  })

  app.use(router.routes()).use(router.allowedMethods())

  const server = app.listen(servicePort, () => {
    console.log(`server started on port ${servicePort}`)
  })

  const close = (): void => {
    clearInterval(sweepInterval)
    onClose?.()
    server.close()
  }

  process.on('uncaughtException', (e) => {
    ctx.error('uncaughtException', { error: e })
  })

  process.on('unhandledRejection', (reason, promise) => {
    ctx.error('Unhandled Rejection at:', { reason, promise })
  })
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  process.on('exit', close)
}
