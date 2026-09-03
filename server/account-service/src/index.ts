//
// Copyright © 2023 Hardcore Engineering Inc.
//

import account, {
  type AccountMethods,
  type Meta,
  type ClientNetworkPosition,
  accountId,
  getAccountDB,
  getMethods,
  cleanExpiredOtp,
  accountPlugin,
  type AccountNotification,
  type CrmNotification,
  parseFreePlanLimits,
  initRegionConfig,
  generateShortId
} from '@hcengineering/account'
import accountEn from '@hcengineering/account/lang/en.json'
import accountRu from '@hcengineering/account/lang/ru.json'
import { Analytics } from '@hcengineering/analytics'
import { registerProviders } from '@hcengineering/auth-providers'
import { metricsAggregate, type Branding, type BrandingMap, type MeasureContext } from '@hcengineering/core'
import platform, { Severity, Status, addStringsLoader, setMetadata, unknownStatus } from '@hcengineering/platform'
import serverToken, {
  decodeToken,
  decodeTokenVerbose,
  extractCookieToken,
  generateToken,
  resolveEdition,
  resolveMaxUsers,
  verifyLicense
} from '@hcengineering/server-token'
import cors from '@koa/cors'
import type Cookies from 'cookies'
import { type IncomingHttpHeaders } from 'http'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import Router from 'koa-router'
import os from 'os'
import { getPlatformQueue } from '@hcengineering/kafka'
import {
  QueueTopic,
  type QueueUserMessage,
  type QueueOnlineUserTx,
  type QueueWorkspaceMessage,
  type QueuePaymentOperationMessage,
  type QueueSubscriptionMessage
} from '@hcengineering/server-core'

import { handlePresenceBatch } from './presence'
export * from './migration/utils'
export * from './migration/types'

const SERVICE_ID = 'account'
const AUTH_TOKEN_COOKIE = 'account-metadata-Token'

const KEEP_ALIVE_HEADERS = {
  'Content-Type': 'application/json',
  Connection: 'keep-alive',
  'Keep-Alive': 'timeout=5, max=1000'
}

/**
 * @public
 */
export function serveAccount (measureCtx: MeasureContext, brandings: BrandingMap, onClose?: () => void): void {
  console.log('Starting account service with brandings: ', brandings)
  const ACCOUNT_PORT = parseInt(process.env.ACCOUNT_PORT ?? '3000')
  const dbUrl = process.env.DB_URL
  if (dbUrl === undefined) {
    console.log('Please provide DB_URL')
    process.exit(1)
  }

  if (dbUrl.startsWith('mongodb://')) {
    if (process.env.PROCEED_V7_MONGO !== 'true') {
      console.error(`
        ⚠️ IMPORTANT: MongoDB Deprecation Notice

        MongoDB support is deprecated in v7 and will be removed in future versions. Important details:

        1. New features may not be available with MongoDB
        2. Testing coverage for MongoDB will be limited
        3. Upgrading to v7 with MongoDB will PERMANENTLY LOCK your deployment to MongoDB-specific types
        4. Migration to CockroachDB will NOT be possible after upgrading

        ➡️ Recommended Action:
        Migrate to CockroachDB before upgrading to v7. See migration instructions at:
        https://github.com/hcengineering/huly-selfhost

        To proceed with MongoDB (despite these limitations):
        Set environment variable PROCEED_V7_MONGO=true.
      `)
      process.exit(1)
    }
  }

  const hasRegionConfig = process.env.REGION_CONFIG !== undefined || process.env.REGION_CONFIG_JSON !== undefined

  const transactorUri = process.env.TRANSACTOR_URL
  if (transactorUri === undefined && !hasRegionConfig) {
    console.log('Please provide transactor url or region config')
    process.exit(1)
  }

  const serverSecret = process.env.SERVER_SECRET
  if (serverSecret === undefined) {
    console.log('Please provide server secret')
    process.exit(1)
  }

  const platformQueue = getPlatformQueue(SERVICE_ID)

  const notificationProducer = platformQueue.getProducer<AccountNotification>(measureCtx, QueueTopic.NotificationQueue)
  setMetadata(accountPlugin.metadata.MailQueue, notificationProducer)

  const crmProducer = platformQueue.getProducer<CrmNotification>(measureCtx, QueueTopic.CrmQueue)
  setMetadata(accountPlugin.metadata.CrmQueue, crmProducer)

  // Limits/payment/maintenance events for transactor/datalake/aibot consumers
  const workspaceProducer = platformQueue.getProducer<QueueWorkspaceMessage>(measureCtx, QueueTopic.Workspace)
  setMetadata(accountPlugin.metadata.WorkspaceQueue, workspaceProducer)

  // Admin-triggered fulltext reindex requests
  const fulltextProducer = platformQueue.getProducer<QueueWorkspaceMessage>(measureCtx, QueueTopic.Fulltext)
  setMetadata(accountPlugin.metadata.FulltextQueue, fulltextProducer)

  // Admin-initiated subscription events consumed by pod-payment (free-plan fallback after a cancel)
  const subscriptionProducer = platformQueue.getProducer<QueueSubscriptionMessage>(measureCtx, QueueTopic.Subscription)
  setMetadata(accountPlugin.metadata.SubscriptionQueue, subscriptionProducer)

  addStringsLoader(accountId, async (lang: string) => {
    switch (lang) {
      case 'en':
        return accountEn
      case 'ru':
        return accountRu
      default:
        return accountEn
    }
  })

  const frontURL = process.env.FRONT_URL
  const productName = process.env.PRODUCT_NAME
  const lang = process.env.LANGUAGE ?? 'en'

  const wsLivenessDaysRaw = process.env.WS_LIVENESS_DAYS
  let wsLivenessDays: number | undefined

  if (wsLivenessDaysRaw !== undefined) {
    try {
      wsLivenessDays = parseInt(wsLivenessDaysRaw)
    } catch (err: any) {
      // DO NOTHING
    }
  }

  setMetadata(account.metadata.Transactors, transactorUri)
  initRegionConfig()
  setMetadata(platform.metadata.locale, lang)
  setMetadata(account.metadata.ProductName, productName)
  setMetadata(account.metadata.OtpTimeToLiveSec, parseInt(process.env.OTP_TIME_TO_LIVE ?? '60'))
  setMetadata(account.metadata.OtpRetryDelaySec, parseInt(process.env.OTP_RETRY_DELAY ?? '60'))
  setMetadata(
    account.metadata.SignUpLinkTimeToLiveSec,
    parseInt(process.env.SIGNUP_LINK_TIME_TO_LIVE ?? `${7 * 24 * 60 * 60}`)
  )
  setMetadata(account.metadata.AdminOtpDevCode, process.env.ADMIN_OTP_DEV_CODE)

  setMetadata(account.metadata.AllowReadonlyGuests, process.env.ALLOW_READONLY_GUESTS === 'true')
  // Self-host edition: account is the single LICENSE_KEY holder. Verify once at startup; payment pods
  // fetch the result via getLicenseInfo (no key of their own). maxUsers=0 on dev (no baked key) ->
  // no clamp; community (no/invalid key) -> 15; licensed -> key's maxUsers. Payment allowed on dev,
  // per-key when licensed, never in community.
  const licenseEdition = resolveEdition(process.env.LICENSE_KEY)
  setMetadata(account.metadata.LicenseMaxUsers, resolveMaxUsers(process.env.LICENSE_KEY))
  setMetadata(account.metadata.LicenseEdition, licenseEdition)
  setMetadata(
    account.metadata.LicenseCanRunPayment,
    licenseEdition === 'dev' || verifyLicense(process.env.LICENSE_KEY)?.canRunPayment === true
  )
  setMetadata(account.metadata.FreePlanLimits, parseFreePlanLimits(process.env.FREE_PLAN_LIMITS))

  setMetadata(account.metadata.FrontURL, frontURL)
  setMetadata(account.metadata.WsLivenessDays, wsLivenessDays)

  setMetadata(serverToken.metadata.Secret, serverSecret)
  // Force undefined, for user tokens do not include service
  setMetadata(serverToken.metadata.Service, undefined)

  const hasSignUp = process.env.DISABLE_SIGNUP !== 'true'
  const methods = getMethods(hasSignUp)

  const dbNs = process.env.DB_NS
  const accountsDb = getAccountDB(dbUrl, dbNs)

  const onlineUserTxProducer = platformQueue.getProducer<QueueOnlineUserTx>(
    measureCtx.newChild('online-user-tx-producer', {}, { span: false }),
    QueueTopic.OnlineUserTx
  )

  const usersConsumer = platformQueue.createBatchConsumer<QueueUserMessage>(
    measureCtx.newChild('users-consumer', {}, { span: false }),
    QueueTopic.Users,
    'presence-tracker',
    async (ctx, msgs) => {
      await handlePresenceBatch(ctx, msgs, accountsDb, onlineUserTxProducer)
    },
    { batchSize: 500, batchTimeout: 1000 }
  )

  // Payment audit: any provider pod publishes operations; the account service appends the ledger row.
  // Durable — a provider ack's its webhook immediately, this consumer persists the audit later.
  const paymentOperationConsumer = platformQueue.createBatchConsumer<QueuePaymentOperationMessage>(
    measureCtx.newChild('payment-operation-consumer', {}, { span: false }),
    QueueTopic.PaymentOperation,
    'payment-ledger',
    async (ctx, msgs) => {
      const [db] = await accountsDb
      for (const m of msgs) {
        const op = m.value
        await db.logPaymentOperation({
          provider: op.provider,
          operation: op.operation,
          status: op.status,
          paymentId: op.paymentId,
          orderId: op.orderId,
          subscriptionId: op.subscriptionId,
          workspaceUuid: op.workspaceUuid as any,
          accountUuid: op.accountUuid as any,
          actionId: op.actionId,
          actor: op.actor,
          amount: op.amount,
          raw: op.raw,
          createdOn: op.at
        })
      }
    },
    { batchSize: 200, batchTimeout: 1000 }
  )

  const app = new Koa()
  const router = new Router()

  app.use(
    cors({
      credentials: true
    })
  )
  app.use(bodyParser())

  registerProviders(
    measureCtx,
    app,
    router,
    new Promise((resolve) => {
      void accountsDb.then((res) => {
        const [db] = res
        resolve(db)
      })
    }),
    serverSecret,
    frontURL,
    brandings,
    !hasSignUp
  )

  void accountsDb.then((res) => {
    const [db] = res
    setInterval(
      () => {
        void cleanExpiredOtp(db)
      },
      3 * 60 * 1000
    )
  })

  const extractAuthorizationToken = (headers: IncomingHttpHeaders): string | undefined => {
    try {
      return headers.authorization?.slice(7) ?? undefined
    } catch {
      return undefined
    }
  }

  const extractToken = (headers: IncomingHttpHeaders): string | undefined => {
    return extractAuthorizationToken(headers) ?? extractCookieToken(headers.cookie, AUTH_TOKEN_COOKIE)
  }

  const getRequestMeta = (headers: IncomingHttpHeaders, isServiceRequest: boolean): Meta => {
    const meta: Meta = {}

    if (!isServiceRequest && headers?.['x-timezone'] !== undefined) {
      meta.timezone = headers['x-timezone'] as string
    }

    if (headers?.['x-client-network-position'] !== undefined) {
      const val = headers['x-client-network-position'] as string
      if (['internal', 'external'].includes(val)) {
        meta.clientNetworkPosition = val as ClientNetworkPosition
      }
    }

    if (headers?.cookie !== undefined) {
      meta.cookies = headers.cookie
    }

    return meta
  }

  function getBranding (ctx: Koa.Context): Branding | null {
    const keys = Object.keys(brandings)
    if (keys.length === 0) return null

    let host: string | undefined
    const origin =
      ctx.request.headers.origin ??
      ctx.request.headers.referer ??
      (ctx.request.headers['x-origin'] as string | undefined)

    if (origin !== undefined) {
      host = new URL(origin).host
    }
    let branding: Branding | null = null

    if (host !== undefined) {
      branding = brandings[host]
    }

    return branding ?? brandings[keys[0]] ?? null
  }

  function getCookieOptions (ctx: Koa.Context): Cookies.SetOption[] {
    const option = {
      httpOnly: true,
      secure: ctx.request.secure,
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year
    }

    const options = []

    const branding = getBranding(ctx)

    const origin = ctx.request.headers.origin ?? ctx.request.headers.referer
    const target = ctx.request.href

    const originDomain = origin !== undefined ? getCookieDomain(origin) : undefined
    const targetDomain = getCookieDomain(target)

    options.push({ ...option, domain: targetDomain })
    if (originDomain !== undefined && originDomain !== targetDomain && branding !== undefined) {
      options.push({ ...option, domain: originDomain })
    }

    return options
  }

  /**
   * Extracts the cookie domain from a URL.
   * By default, it returns the full hostname to prevent cross-environment cookie conflicts.
   * If USE_PARENT_DOMAIN_FOR_COOKIES environment variable is set to 'true',
   * it will return the parent domain instead (original behavior).
   */
  const getCookieDomain = (url: string): string => {
    const hostname = new URL(url).hostname

    if (hostname === 'localhost') {
      return hostname
    }

    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
      return hostname
    }

    // Check if we should use the parent domain instead of the full hostname
    const useParentDomain = process.env.USE_PARENT_DOMAIN_FOR_COOKIES === 'true'

    if (useParentDomain) {
      const parts = hostname.split('.')
      if (parts.length > 2) {
        return '.' + parts.slice(1).join('.')
      }
    }

    return hostname
  }

  router.get('/api/v1/statistics', (req, res) => {
    try {
      const token = (req.query.token as string) ?? extractToken(req.headers)
      const payload = decodeToken(token)
      const admin = payload.extra?.admin === 'true' || payload.extra?.billingAdmin === 'true'
      const data: Record<string, any> = {
        metrics: admin ? metricsAggregate((measureCtx as any).metrics) : {},
        statistics: {}
      }
      data.statistics.totalClients = 0
      const mem = process.memoryUsage()
      data.statistics.memoryUsed = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100
      data.statistics.memoryTotal = Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100
      data.statistics.memoryRSS = Math.round((mem.rss / 1024 / 1024) * 100) / 100
      data.statistics.memoryArrayBuffers = Math.round((mem.arrayBuffers / 1024 / 1024) * 100) / 100
      data.statistics.cpuUsage = Math.round(os.loadavg()[0] * 100) / 100
      data.statistics.freeMem = Math.round((os.freemem() / 1024 / 1024) * 100) / 100
      data.statistics.totalMem = Math.round((os.totalmem() / 1024 / 1024) * 100) / 100
      const json = JSON.stringify(data)
      req.res.writeHead(200, KEEP_ALIVE_HEADERS)
      req.res.end(json)
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.put('/cookie', async (ctx) => {
    const token = extractToken(ctx.request.headers)
    if (token === undefined) {
      ctx.body = JSON.stringify({
        error: new Status(Severity.ERROR, platform.status.Unauthorized, {})
      })
      ctx.res.writeHead(401)
      ctx.res.end()
      return
    }

    // Ensure we don't set the token with workspace to the cookie
    const { account, extra } = decodeTokenVerbose(measureCtx, token)
    const tokenWithoutWorkspace = generateToken(account, undefined, extra)

    const cookieOpts = getCookieOptions(ctx)
    for (const opt of cookieOpts) {
      ctx.cookies.set(AUTH_TOKEN_COOKIE, tokenWithoutWorkspace, opt)
    }

    ctx.res.writeHead(204)
    ctx.res.end()
  })

  router.delete('/cookie', async (ctx) => {
    const cookieOpts = getCookieOptions(ctx)
    for (const opt of cookieOpts) {
      ctx.cookies.set(AUTH_TOKEN_COOKIE, '', { ...opt, maxAge: 0 })
    }

    ctx.res.writeHead(204)
    ctx.res.end()
  })

  router.post('rpc', '/', async (ctx) => {
    const token = extractToken(ctx.request.headers)

    const request = ctx.request.body as any
    const method = methods[request.method as AccountMethods]
    if (method === undefined) {
      const response = {
        id: request.id,
        error: new Status(Severity.ERROR, platform.status.UnknownMethod, { method: request.method })
      }

      const body = JSON.stringify(response)
      ctx.res.writeHead(404, KEEP_ALIVE_HEADERS)
      ctx.res.end(body)
      return
    }

    const [db] = await accountsDb

    const branding = getBranding(ctx)

    let source = ''
    let isServiceRequest = false
    try {
      const decodedToken = token != null ? decodeToken(token) : null
      const serviceName = decodedToken?.extra?.service
      source = serviceName ?? '🤦‍♂️user'
      isServiceRequest = serviceName !== undefined
    } catch (err) {
      // Ignore
    }
    const meta = getRequestMeta(ctx.request.headers, isServiceRequest)

    await measureCtx.with(
      request.method,
      { source },
      async (_ctx) => {
        if (method === undefined || typeof method !== 'function') {
          const response = {
            id: request.id,
            error: new Status(Severity.ERROR, platform.status.UnknownMethod, { method: request.method })
          }

          ctx.res.writeHead(400, KEEP_ALIVE_HEADERS)
          ctx.res.end(JSON.stringify(response))
          return
        }

        try {
          const result = await method(_ctx, db, branding, request, token, meta)

          const body = JSON.stringify(result)
          ctx.res.writeHead(200, KEEP_ALIVE_HEADERS)
          ctx.res.end(body)
        } catch (err: any) {
          const response = {
            id: request.id,
            error: unknownStatus(err.message)
          }
          ctx.res.writeHead(400, KEEP_ALIVE_HEADERS)
          ctx.res.end(JSON.stringify(response))
        }
      },
      { method: request.method },
      { metric: 'account.rpc.duration' }
    )
  })

  // ======= S H O R T   L I N K S =======

  router.post('/api/v1/createShortLink', async (ctx) => {
    const token = extractToken(ctx.request.headers)
    if (token === undefined) {
      ctx.res.writeHead(401, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    try {
      const decoded = decodeToken(token)
      if (decoded.extra?.service === undefined) {
        ctx.res.writeHead(403, KEEP_ALIVE_HEADERS)
        ctx.res.end(JSON.stringify({ error: 'Forbidden: service token required' }))
        return
      }
    } catch {
      ctx.res.writeHead(401, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'Invalid token' }))
      return
    }

    const { payload, workspaceId } = ctx.request.body as any

    if (typeof payload !== 'string' || typeof workspaceId !== 'string') {
      ctx.res.writeHead(400, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'payload and workspaceId are required' }))
      return
    }

    try {
      const [db] = await accountsDb

      // Reuse an existing link for the same payload so repeated requests
      // (e.g. "copy guest link" for one meeting) yield a stable URL.
      const existing = await db.shortLink.findOne({ payload, workspaceId })
      const shortId = existing?.id ?? generateShortId()
      if (existing == null) {
        await db.shortLink.insertOne({ id: shortId, payload, workspaceId })
      }

      ctx.res.writeHead(200, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ shortId }))
    } catch (err: any) {
      Analytics.handleError(err)
      measureCtx.error('createShortLink failed', { error: err })
      ctx.res.writeHead(500, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  })

  router.get('/api/v1/resolveShortLink/:shortId', async (ctx) => {
    const shortId = ctx.params.shortId

    if (typeof shortId !== 'string' || shortId.length === 0) {
      ctx.res.writeHead(400, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'shortId is required' }))
      return
    }

    try {
      const [db] = await accountsDb

      const link = await db.shortLink.findOne({ id: shortId })

      if (link === null) {
        ctx.res.writeHead(404, KEEP_ALIVE_HEADERS)
        ctx.res.end(JSON.stringify({ error: 'Link not found' }))
        return
      }

      ctx.res.writeHead(200, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ payload: link.payload }))
    } catch (err: any) {
      Analytics.handleError(err)
      measureCtx.error('resolveShortLink failed', { error: err })
      ctx.res.writeHead(500, KEEP_ALIVE_HEADERS)
      ctx.res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  })

  app.use(router.routes()).use(router.allowedMethods())

  const server = app.listen(ACCOUNT_PORT, () => {
    console.log(`server started on port ${ACCOUNT_PORT}`)
  })

  // Without an explicit exit the process outlives SIGTERM: kafka sockets and koa keep-alive
  // connections hold the event loop, and the pod only dies when the orchestrator SIGKILLs it.
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    onClose?.()
    const closed = Promise.allSettled([
      notificationProducer.close(),
      crmProducer.close(),
      subscriptionProducer.close(),
      usersConsumer.close(),
      paymentOperationConsumer.close(),
      platformQueue.shutdown(),
      accountsDb.then(([, closeAccountsDb]) => {
        closeAccountsDb()
      })
    ])
    server.close()
    server.closeAllConnections()
    // Cap the wait so a stuck client cannot keep the pod alive either.
    const cap = setTimeout(() => {
      process.exit(0)
    }, 5000)
    cap.unref()
    void closed.then(() => {
      process.exit(0)
    })
  }

  process.on('uncaughtException', (e) => {
    measureCtx.error('uncaughtException', { error: e })
  })

  process.on('unhandledRejection', (reason, promise) => {
    measureCtx.error('Unhandled Rejection at:', { reason, promise })
  })
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  process.on('exit', close)
}
