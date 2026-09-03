import { getClient as getAccountClientRaw, type AccountClient } from '@hcengineering/account-client'
import { ensureEmployeeForPerson } from '@hcengineering/contact'
import core, {
  buildSocialIdString,
  generateId,
  type PersonId,
  pickPrimarySocialId,
  type Space,
  systemAccountUuid,
  type Timestamp,
  TxOperations,
  TxProcessor,
  type AttachedData,
  type Class,
  type Data,
  type Doc,
  type MeasureContext,
  type OperationDomain,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type TxCUD,
  type TxDomainEvent,
  type TxMeta,
  type DocumentUpdate,
  type Mixin,
  type MixinData,
  type MixinUpdate,
  type SocialIdType,
  AccountRole,
  type Account,
  type AccountUuid,
  type Person as GlobalPerson,
  type SocialId,
  type Client,
  type FindOptions,
  type FindResult,
  type DocumentQuery,
  type Tx,
  type TxResult,
  type WithLookup
} from '@hcengineering/core'
import { rpcJSONReplacer, type RateLimitInfo } from '@hcengineering/rpc'
import platform, { PlatformError, unknownError } from '@hcengineering/platform'
import {
  wrapPipeline,
  type ClientSessionCtx,
  type ConnectionSocket,
  type Session,
  type SessionManager
} from '@hcengineering/server-core'
import { decodeToken } from '@hcengineering/server-token'

import { createHash } from 'crypto'
import { type Express, type Response as ExpressResponse, type Request } from 'express'
import type { OutgoingHttpHeaders } from 'http2'
import { compress } from 'snappy'
import { promisify } from 'util'
import { gzip } from 'zlib'
import { retrieveJson } from './utils'

interface RPCClientInfo {
  client: ConnectionSocket
  session: Session
  workspaceId: string
  context: MeasureContext
}

const gzipAsync = promisify(gzip)

const keepAliveOptions = {
  'keep-alive': 'timeout=5, max=1000',
  Connection: 'keep-alive'
}

const sendError = (res: ExpressResponse, code: number, data: any): void => {
  res.writeHead(code, {
    ...keepAliveOptions,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  })
  res.end(JSON.stringify(data))
}

function rateLimitToHeaders (rateLimit?: RateLimitInfo): OutgoingHttpHeaders {
  if (rateLimit === undefined) {
    return {}
  }
  const { remaining, limit, reset, retryAfter } = rateLimit
  return {
    'Retry-After': `${Math.max(Math.round((retryAfter ?? 0) / 1000), 1)}`,
    'Retry-After-ms': `${retryAfter ?? 1000}`,
    'X-RateLimit-Limit': `${limit}`,
    'X-RateLimit-Remaining': `${remaining}`,
    'X-RateLimit-Reset': `${reset}`
  }
}

function rtcEtag (entity: Buffer): string {
  if (entity.length === 0) {
    return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'
  }

  // compute hash of entity
  const hash = createHash('sha1').update(entity).digest('base64').substring(0, 27)

  // compute length of entity
  const len = entity.length

  return '"' + len.toString(16) + '-' + hash + '"'
}

async function sendJson (
  req: Request,
  res: ExpressResponse,
  result: any,
  extraHeaders?: OutgoingHttpHeaders,
  etag?: boolean
): Promise<void> {
  // Calculate ETag only for find operations (default false)
  let body: Buffer = Buffer.from(JSON.stringify(result, rpcJSONReplacer), 'utf8')

  const headers: OutgoingHttpHeaders = {
    ...(extraHeaders ?? {}),
    ...keepAliveOptions,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  }

  // Calculate etag only when requested (for find operations)
  if (etag === true) {
    const etagValue = rtcEtag(body)
    headers.ETag = etagValue

    // Check if the ETag matches
    if (req.headers['if-none-match'] === etagValue) {
      res.writeHead(304, headers)
      res.end()
      return
    }
  }

  const contentEncodings: string[] =
    typeof req.headers['accept-encoding'] === 'string'
      ? req.headers['accept-encoding'].split(',').map((it) => it.trim())
      : (req.headers['accept-encoding'] ?? [])
  for (const contentEncoding of contentEncodings) {
    let done = false
    switch (contentEncoding) {
      case 'snappy':
        headers['content-encoding'] = 'snappy'
        body = await compress(body)
        done = true
        break
      case 'gzip':
        headers['content-encoding'] = 'gzip'
        body = await gzipAsync(body)
        done = true
        break
    }
    if (done) {
      break
    }
  }
  headers['content-length'] = body.length
  res.writeHead(200, headers)
  res.end(body)
}

export function registerRPC (app: Express, sessions: SessionManager, ctx: MeasureContext, accountsUrl: string): void {
  const rpcSessions = new Map<string, RPCClientInfo>()

  function getAccountClient (token?: string): AccountClient {
    return getAccountClientRaw(accountsUrl, token)
  }

  async function withSession (
    req: Request,
    res: ExpressResponse,
    method: string,
    operation: (
      ctx: ClientSessionCtx,
      session: Session,
      rateLimit: RateLimitInfo | undefined,
      token: string
    ) => Promise<void>
  ): Promise<void> {
    try {
      if (req.params.workspaceId === undefined || req.params.workspaceId === '') {
        res.writeHead(400, {})
        res.end('Missing workspace')
        return
      }
      let token = req.headers.authorization as string
      if (token === null) {
        sendError(res, 401, { message: 'Missing Authorization header' })
        return
      }
      const workspaceId = decodeURIComponent(req.params.workspaceId)
      token = token.split(' ')[1]

      const decodedToken = decodeToken(token)
      if (workspaceId !== decodedToken.workspace) {
        sendError(res, 403, { message: 'Invalid workspace', workspace: decodedToken.workspace })
        return
      }

      let transactorRpc = rpcSessions.get(token)

      if (transactorRpc === undefined) {
        const cs: ConnectionSocket = createClosingSocket(token, rpcSessions, {
          rpc: true,
          account: decodedToken.account,
          service: decodedToken.extra?.service
        })
        const s = await sessions.addSession(ctx, cs, decodedToken, token, token)
        if (!('session' in s)) {
          sendError(res, 403, {
            message: 'Failed to create session',
            mode: 'specialError' in s ? (s.specialError ?? '') : 'upgrading'
          })
          return
        }
        transactorRpc = { session: s.session, client: cs, workspaceId: s.workspaceId, context: s.context }
        rpcSessions.set(token, transactorRpc)
      }

      const rpc = transactorRpc
      const rateLimit = await sessions.handleRPC(
        rpc.context,
        rpc.session,
        method,
        rpc.client,
        async (ctx, rateLimit) => {
          await operation(ctx, rpc.session, rateLimit, token)
        }
      )
      if (rateLimit !== undefined) {
        const { remaining, limit, reset, retryAfter } = rateLimit
        const retryHeaders: OutgoingHttpHeaders = {
          ...keepAliveOptions,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Retry-After': `${Math.max(Math.round((retryAfter ?? 0) / 1000), 1)}`,
          'Retry-After-ms': `${retryAfter ?? 1000}`,
          'X-RateLimit-Limit': `${limit}`,
          'X-RateLimit-Remaining': `${remaining}`,
          'X-RateLimit-Reset': `${reset}`
        }
        res.writeHead(429, retryHeaders)
        res.end(
          JSON.stringify({
            id: -1,
            error: unknownError('Rate limit')
          })
        )
      }
    } catch (err: any) {
      if (err instanceof PlatformError) {
        const statusCode =
          err.status.code === platform.status.BadRequest
            ? 400
            : err.status.code === platform.status.Unauthorized
              ? 401
              : err.status.code === platform.status.Forbidden || err.status.code === platform.status.PlanLimitExceeded
                ? 403
                : 500
        sendError(res, statusCode, { message: err.message, error: err.status })
      } else {
        sendError(res, 500, { message: 'Failed to execute operation', error: err.message })
      }
    }
  }

  app.get('/api/v1/ping/:workspaceId', (req, res) => {
    void withSession(req, res, 'ping', async (ctx, session, rateLimit) => {
      await session.ping(ctx)
      await sendJson(
        req,
        res,
        {
          pong: true,
          lastTx: ctx.pipeline.context.lastTx,
          lastHash: ctx.pipeline.context.lastHash
        },
        rateLimitToHeaders(rateLimit)
      )
    })
  })

  app.get('/api/v1/find-all/:workspaceId', (req, res) => {
    void withSession(req, res, 'findAll', async (ctx, session, rateLimit) => {
      const _class = req.query.class as Ref<Class<Doc>>
      const query = req.query.query !== undefined ? JSON.parse(req.query.query as string) : {}
      const options = req.query.options !== undefined ? JSON.parse(req.query.options as string) : {}
      if (req.query.limit !== undefined) {
        options.limit = parseInt(req.query.limit as string)
      }

      const domain = ctx.pipeline.context.hierarchy.findDomain(_class) ?? ''
      if (domain === '') {
        sendError(res, 404, {
          message: 'Failed to execute operation',
          error: 'Invalid class name is passed. Failed to findAll.'
        })
        return
      }

      const result = await session.findAllRaw(ctx, _class, query, options)
      await sendJson(req, res, result, rateLimitToHeaders(rateLimit), true)
    })
  })

  app.post('/api/v1/find-all/:workspaceId', (req, res) => {
    void withSession(req, res, 'findAll', async (ctx, session, rateLimit) => {
      const { _class, query, options }: any = (await retrieveJson(req)) ?? {}

      const result = await session.findAllRaw(ctx, _class, query, options)
      await sendJson(req, res, result, rateLimitToHeaders(rateLimit), true)
    })
  })

  app.post('/api/v1/tx/:workspaceId', (req, res) => {
    void withSession(req, res, 'tx', async (ctx, session, rateLimit) => {
      const tx: any = (await retrieveJson(req)) ?? {}

      if (tx._class === core.class.TxDomainEvent) {
        const domainTx = tx as TxDomainEvent
        const { result } = await session.domainRequestRaw(ctx, domainTx.domain, {
          event: domainTx.event
        })
        await sendJson(req, res, result.value, rateLimitToHeaders(rateLimit))
      } else {
        const result = await session.txRaw(ctx, tx)
        await sendJson(req, res, result.result, rateLimitToHeaders(rateLimit))
      }
    })
  })

  app.post('/api/v1/create/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-create', async (ctx, session, rateLimit) => {
      const request: {
        _class: Ref<Class<any>>
        space: Ref<Space>
        attributes: Data<any>
        id?: Ref<any>
        modifiedOn?: Timestamp
        modifiedBy?: PersonId
        meta?: TxMeta
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const ops = new TxOperations(client, pid)

      await sendJson(
        req,
        res,
        await ops.createDoc(
          request._class,
          request.space,
          request.attributes,
          request.id ?? generateId(),
          request.modifiedOn,
          request.modifiedBy ?? pid,
          request.meta
        ),
        rateLimitToHeaders(rateLimit)
      )
    })
  })

  app.post('/api/v1/addCollection/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-addCollection', async (ctx, session, rateLimit) => {
      const request: {
        _class: Ref<Class<any>>
        space: Ref<Space>
        attachedTo: Ref<any>
        attachedToClass: Ref<Class<any>>
        collection: string
        attributes: AttachedData<any>
        id?: Ref<any>
        modifiedOn?: Timestamp
        modifiedBy?: PersonId
        meta?: TxMeta
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const ops = new TxOperations(client, pid)

      await sendJson(
        req,
        res,
        await ops.addCollection(
          request._class,
          request.space,
          request.attachedTo,
          request.attachedToClass,
          request.collection,
          request.attributes,
          request.id ?? generateId(),
          request.modifiedOn,
          request.modifiedBy ?? pid,
          request.meta
        ),
        rateLimitToHeaders(rateLimit)
      )
    })
  })

  app.post('/api/v1/update/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-update', async (ctx, session, rateLimit) => {
      const request: {
        _class: Ref<Class<any>>
        _id: Ref<any>
        space: Ref<Space>
        attachedTo: Ref<any>
        attachedToClass: Ref<Class<any>>
        collection: string
        update: DocumentUpdate<any>
        retrieve?: boolean
        modifiedOn?: Timestamp
        modifiedBy?: PersonId
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const rops = new TxOperations(client, pid)

      const hierarchy = ctx.pipeline.context.hierarchy
      async function doOp (): Promise<any> {
        if (hierarchy.isDerived(request._class, core.class.AttachedDoc)) {
          return await rops.updateCollection(
            request._class,
            request.space,
            request._id,
            request.attachedTo,
            request.attachedToClass,
            request.collection,
            request.update,
            request.retrieve,
            request.modifiedOn,
            request.modifiedBy ?? pid
          )
        }
        return await rops.updateDoc(
          request._class,
          request.space,
          request._id,
          request.update,
          request.retrieve,
          request.modifiedOn,
          request.modifiedBy ?? pid
        )
      }
      await sendJson(req, res, await doOp(), rateLimitToHeaders(rateLimit))
    })
  })

  app.post('/api/v1/createMixin/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-create', async (ctx, session, rateLimit) => {
      const request: {
        objectId: Ref<Doc>
        objectClass: Ref<Class<Doc>>
        objectSpace: Ref<Space>
        mixin: Ref<Mixin<Doc>>
        attributes: MixinData<Doc, Doc>
        modifiedOn?: Timestamp
        modifiedBy?: PersonId
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const ops = new TxOperations(client, pid)

      await sendJson(
        req,
        res,
        await ops.createMixin(
          request.objectId,
          request.objectClass,
          request.objectSpace,
          request.mixin,
          request.attributes,
          request.modifiedOn,
          request.modifiedBy ?? pid
        ),
        rateLimitToHeaders(rateLimit)
      )
    })
  })
  app.post('/api/v1/updateMixin/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-create', async (ctx, session, rateLimit) => {
      const request: {
        objectId: Ref<Doc>
        objectClass: Ref<Class<Doc>>
        objectSpace: Ref<Space>
        mixin: Ref<Mixin<Doc>>
        attributes: MixinUpdate<Doc, Doc>
        modifiedOn?: Timestamp
        modifiedBy?: PersonId
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const ops = new TxOperations(client, pid)

      await sendJson(
        req,
        res,
        await ops.updateMixin(
          request.objectId,
          request.objectClass,
          request.objectSpace,
          request.mixin,
          request.attributes,
          request.modifiedOn,
          request.modifiedBy ?? pid
        ),
        rateLimitToHeaders(rateLimit)
      )
    })
  })

  app.post('/api/v1/remove/:workspaceId', (req, res) => {
    void withSession(req, res, 'v1-create', async (ctx, session, rateLimit) => {
      const request: {
        _class: Ref<Class<any>>
        _id: Ref<any>
        space: Ref<Space>
        modifiedOn?: Timestamp
        modifiedBy?: PersonId

        attachedTo: Ref<any>
        attachedToClass: Ref<Class<any>>
        collection: string
      } = (await retrieveJson(req)) ?? {}

      const pid = session.getRawAccount().primarySocialId
      const client = wrapPipeline(ctx.ctx, ctx.pipeline, session.workspace, true)
      const ops = new TxOperations(client, pid)

      if (ctx.pipeline.context.hierarchy.isDerived(request._class, core.class.AttachedDoc)) {
        await sendJson(
          req,
          res,
          await ops.removeCollection(
            request._class,
            request.space,
            request._id,
            request.attachedTo,
            request.attachedToClass,
            request.collection,
            request.modifiedOn,
            request.modifiedBy ?? pid
          ),
          rateLimitToHeaders(rateLimit)
        )
      } else {
        await sendJson(
          req,
          res,
          await ops.removeDoc(request._class, request.space, request._id),
          rateLimitToHeaders(rateLimit)
        )
      }
    })
  })

  /**
   * @deprecated Use /api/v1/tx/:workspaceIdd instead
   */
  app.get('/api/v1/account/:workspaceId', (req, res) => {
    void withSession(req, res, 'account', async (ctx, session, rateLimit) => {
      const result = session.getRawAccount()
      await sendJson(req, res, result, rateLimitToHeaders(rateLimit))
    })
  })

  app.get('/api/v1/load-model/:workspaceId', (req, res) => {
    void withSession(req, res, 'loadModel', async (ctx, session, rateLimit) => {
      const lastModelTx = parseInt((req.query.lastModelTx as string) ?? '0')
      const lastHash = req.query.lastHash as string
      const result = await session.loadModelRaw(ctx, lastModelTx, lastHash)
      const txes = Array.isArray(result) ? result : result.transactions
      const shouldFilter = req.query.full !== 'true'
      if (shouldFilter) {
        // we need to filter only hierarchy related txes.
        const allowedClasess: Ref<Class<Doc>>[] = [
          core.class.Class,
          core.class.Attribute,
          core.class.Mixin,
          core.class.Type,
          core.class.Status,
          core.class.Permission,
          core.class.Space,
          core.class.Tx
        ]
        const h = ctx.pipeline.context.hierarchy
        const filtered = txes.filter(
          (it) =>
            TxProcessor.isExtendsCUD(it._class) &&
            allowedClasess.some((cl) => h.isDerived((it as TxCUD<Doc>).objectClass, cl))
        )

        await sendJson(req, res, filtered, rateLimitToHeaders(rateLimit))
      } else {
        await sendJson(req, res, txes, rateLimitToHeaders(rateLimit))
      }
    })
  })

  app.get('/api/v1/search-fulltext/:workspaceId', (req, res) => {
    void withSession(req, res, 'searchFulltext', async (ctx, session, rateLimit) => {
      const query: SearchQuery = {
        query: req.query.query as string,
        classes: req.query.classes !== undefined ? JSON.parse(req.query.classes as string) : undefined,
        spaces: req.query.spaces !== undefined ? JSON.parse(req.query.spaces as string) : undefined
      }
      const options: SearchOptions = {
        limit: req.query.limit !== undefined ? parseInt(req.query.limit as string) : undefined
      }
      const result = await session.searchFulltextRaw(ctx, query, options)
      await sendJson(req, res, result, rateLimitToHeaders(rateLimit), true)
    })
  })

  app.get('/api/v1/request/:domain/:operation/:workspaceId', (req, res) => {
    void withSession(req, res, 'domainRequest', async (ctx, session) => {
      const domain = req.params.domain as OperationDomain
      const operation = req.params.operation

      const params = req.query.params !== undefined ? JSON.parse(req.query.params as string) : {}

      const { result } = await session.domainRequestRaw(ctx, domain, {
        [operation]: { params }
      })
      await sendJson(req, res, result.value)
    })
  })

  app.post('/api/v1/request/:domain/:workspaceId', (req, res) => {
    void withSession(req, res, 'domainRequest', async (ctx, session) => {
      const domain = req.params.domain as OperationDomain
      const params = await retrieveJson(req)
      const { result } = await session.domainRequestRaw(ctx, domain, params)
      await sendJson(req, res, result.value)
    })
  })

  interface EnsurePersonOptions {
    addGuestEmployee?: boolean
  }

  app.post('/api/v1/ensure-person/:workspaceId', (req, res) => {
    void withSession(req, res, 'ensurePerson', async (ctx, session, rateLimit, token) => {
      const {
        socialType,
        socialValue,
        firstName,
        lastName,
        options
      }: {
        socialType: SocialIdType
        socialValue: string
        firstName: string
        lastName: string
        options?: EnsurePersonOptions
      } = (await retrieveJson(req)) ?? {}
      const accountClient = getAccountClient(token)

      const { uuid, socialId } = await accountClient.ensurePerson(socialType, socialValue, firstName, lastName)

      const primarySocialId =
        session.getUser() === systemAccountUuid ? core.account.System : pickPrimarySocialId(session.getSocialIds())._id

      // Adapter wrapping server Session as a Client for ensureEmployeeForPerson
      const clientAdapter: Pick<Client, 'findOne' | 'findAll' | 'tx'> = {
        findOne: async <T extends Doc>(
          _class: Ref<Class<T>>,
          query: DocumentQuery<T>,
          opts?: FindOptions<T>
        ): Promise<WithLookup<T> | undefined> => {
          const result = await session.findAllRaw(ctx, _class, query, { ...(opts ?? {}), limit: 1 })
          return result[0]
        },
        findAll: async <T extends Doc>(
          _class: Ref<Class<T>>,
          query: DocumentQuery<T>,
          opts?: FindOptions<T>
        ): Promise<FindResult<T>> => {
          return await session.findAllRaw(ctx, _class, query, opts)
        },
        tx: async (tx: Tx): Promise<TxResult> => await session.txRaw(ctx, tx)
      }

      const socialIdEntry: SocialId = {
        _id: socialId,
        type: socialType,
        value: socialValue,
        key: buildSocialIdString({ type: socialType, value: socialValue }),
        verifiedOn: Date.now(),
        isDeleted: false
      }

      const account: Account = {
        uuid: uuid as AccountUuid,
        primarySocialId,
        role: options?.addGuestEmployee === true ? AccountRole.Guest : AccountRole.User,
        socialIds: [socialId],
        fullSocialIds: [socialIdEntry]
      }

      const globalPerson: GlobalPerson = {
        uuid,
        firstName,
        lastName
      }

      const personRef = await ensureEmployeeForPerson(
        ctx.ctx,
        account,
        account,
        clientAdapter,
        [socialIdEntry],
        globalPerson,
        { createEmployee: options?.addGuestEmployee === true, roleOverride: 'GUEST' }
      )

      const result = { uuid, socialId, localPerson: personRef }

      await sendJson(req, res, result, rateLimitToHeaders(rateLimit))
    })
  })

  // To use in non-js (rust) clients that can't link to @hcengineering/core
  app.get('/api/v1/generate-id/:workspaceId', (req, res) => {
    void withSession(req, res, 'generateId', async (ctx, session, rateLimit) => {
      const result = { id: generateId() }
      await sendJson(req, res, result, rateLimitToHeaders(rateLimit))
    })
  })
}

function createClosingSocket (
  rawToken: string,
  rpcSessions: Map<string, RPCClientInfo>,
  data: Record<string, any> = {}
): ConnectionSocket {
  return {
    id: rawToken,
    isClosed: false,
    close: () => {
      rpcSessions.delete(rawToken)
    },
    send: async (ctx, msg, binary, compression, memo) => {},
    isBackpressure: () => false,
    backpressure: async (ctx) => {},
    sendPong: () => {},
    data: () => data,
    readRequest: (buffer, binary) => ({ method: '', params: [], id: -1, time: Date.now() }),
    checkState: () => true
  }
}
