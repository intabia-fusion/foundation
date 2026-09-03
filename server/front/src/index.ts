//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2025 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import { MeasureContext, Blob as PlatformBlob, WorkspaceIds, metricsAggregate } from '@hcengineering/core'
import platform, { PlatformError } from '@hcengineering/platform'
import { TokenError, decodeToken } from '@hcengineering/server-token'
import { StorageAdapter } from '@hcengineering/storage'
import bp from 'body-parser'
import cors from 'cors'
import express, { Request, Response } from 'express'
import fileUpload, { UploadedFile } from 'express-fileupload'
import expressStaticGzip from 'express-static-gzip'
import morgan from 'morgan'
import { join, normalize, resolve } from 'path'
import { cwd } from 'process'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { staticCacheLimits, staticMemoryCache } from './staticCache'
import { preConditions } from './utils'

import { createHash } from 'crypto'
import fs, { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

const cacheControlValue = 'public, no-cache, must-revalidate, max-age=365d'
const cacheControlNoCache = 'public, no-store, no-cache, must-revalidate, max-age=0'

const KEEP_ALIVE_TIMEOUT = 5 // seconds
const KEEP_ALIVE_MAX = 1000
const KEEP_ALIVE_HEADERS = {
  Connection: 'keep-alive',
  'Keep-Alive': `timeout=${KEEP_ALIVE_TIMEOUT}, max=${KEEP_ALIVE_MAX}`
}

async function storageUpload (
  ctx: MeasureContext,
  storageAdapter: StorageAdapter,
  wsIds: WorkspaceIds,
  file: UploadedFile
): Promise<{ uuid: string, etag: string }> {
  const uuid = file.name
  const data = file.tempFilePath !== undefined ? fs.createReadStream(file.tempFilePath) : file.data
  const resp = await ctx.with(
    'storage upload',
    {},
    (ctx) => storageAdapter.put(ctx, wsIds, uuid, data, file.mimetype, file.size),
    { file: file.name, contentType: file.mimetype, workspace: wsIds.uuid }
  )

  ctx.info('storage upload', resp)
  return { uuid, etag: resp.etag }
}

function getRange (range: string, size: number): [number, number] {
  const [startStr, endStr] = range.replace(/bytes=/, '').split('-')

  let start = parseInt(startStr, 10)
  let end = endStr !== undefined ? parseInt(endStr, 10) : size - 1

  if (!isNaN(start) && isNaN(end)) {
    end = size - 1
  }

  if (isNaN(start) && !isNaN(end)) {
    start = size - end
    end = size - 1
  }

  return [start, end]
}

async function getFileRange (
  ctx: MeasureContext,
  stat: PlatformBlob,
  range: string,
  client: StorageAdapter,
  wsIds: WorkspaceIds,
  res: Response
): Promise<void> {
  const uuid = stat._id
  const size: number = stat.size

  const [start, end] = getRange(range, size)

  if (start >= size || end >= size) {
    res.writeHead(416, {
      'Content-Range': `bytes */${size}`
    })
    res.end()
    return
  }

  await ctx.with(
    'write',
    { contentType: stat.contentType },
    async (ctx) => {
      try {
        const dataStream = await ctx.with(
          'partial',
          {},
          (ctx) => client.partial(ctx, wsIds, stat._id, start, end - start + 1),
          {}
        )
        res.writeHead(206, {
          ...KEEP_ALIVE_HEADERS,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': stat.contentType,
          'Content-Security-Policy': "default-src 'none';",
          Etag: stat.etag,
          'Last-Modified': new Date(stat.modifiedOn).toISOString()
        })

        dataStream.pipe(res)

        await new Promise<void>((resolve, reject) => {
          dataStream.on('end', () => {
            dataStream.destroy()
            res.end()
            resolve()
          })
          dataStream.on('error', (err) => {
            ctx.error('error receive stream', { workspace: wsIds.uuid, uuid, error: err })
            Analytics.handleError(err)

            res.end()
            dataStream.destroy()
            reject(err)
          })
        })
      } catch (err: any) {
        if (
          err?.code === 'NoSuchKey' ||
          err?.code === 'NotFound' ||
          err?.message === 'No such key' ||
          err?.Code === 'NoSuchKey'
        ) {
          ctx.info('No such key', { workspace: wsIds.uuid, uuid })
          res.status(404).send()
          return
        } else {
          Analytics.handleError(err)
          ctx.error(err)
        }
        res.status(500).send()
      }
    },
    { uuid, start, end: end - start + 1 }
  )
}

async function getFile (
  ctx: MeasureContext,
  stat: PlatformBlob,
  client: StorageAdapter,
  wsIds: WorkspaceIds,
  req: Request,
  res: Response
): Promise<void> {
  const etag = stat.etag

  if (
    preConditions.IfNoneMatch(req.headers, { etag }) === 'notModified' ||
    preConditions.IfMatch(req.headers, { etag }) === 'notModified' ||
    preConditions.IfModifiedSince(req.headers, { lastModified: new Date(stat.modifiedOn) }) === 'notModified'
  ) {
    // Matched, return not modified
    res.writeHead(304, {
      ...KEEP_ALIVE_HEADERS,
      'content-type': stat.contentType,
      etag: stat.etag,
      'last-modified': new Date(stat.modifiedOn).toISOString(),
      'cache-control': cacheControlValue
    })
    res.end()
    return
  }
  if (preConditions.IfUnmodifiedSince(req.headers, { lastModified: new Date(stat.modifiedOn) }) === 'failed') {
    // Send 412 (Precondition Failed)
    res.writeHead(412, {
      ...KEEP_ALIVE_HEADERS,
      'content-type': stat.contentType,
      etag: stat.etag,
      'last-modified': new Date(stat.modifiedOn).toISOString(),
      'cache-control': cacheControlValue
    })
    res.end()
    return
  }

  await ctx.with(
    'write',
    { contentType: stat.contentType },
    async (ctx) => {
      try {
        const dataStream = await ctx.with('readable', {}, (ctx) => client.get(ctx, wsIds, stat._id))
        res.writeHead(200, {
          'Content-Type': stat.contentType,
          'Content-Security-Policy': "default-src 'none';",
          'Content-Length': stat.size,
          Etag: stat.etag,
          'Last-Modified': new Date(stat.modifiedOn).toISOString(),
          'Cache-Control': cacheControlValue,
          connection: 'keep-alive',
          'keep-alive': 'timeout=5, max=1000'
        })

        dataStream.pipe(res)
        await new Promise<void>((resolve, reject) => {
          dataStream.on('end', function () {
            res.end()
            dataStream.destroy()
            resolve()
          })
          dataStream.on('error', function (err) {
            Analytics.handleError(err)
            ctx.error('error', { err })

            res.end()
            dataStream.destroy()
            reject(err)
          })
        })
      } catch (err: any) {
        ctx.error('get-file-error', { workspace: wsIds.uuid, err })
        Analytics.handleError(err)
        res.status(500).send()
      }
    },
    {}
  )
}

/**
 * @public
 * @param port -
 */
export function start (
  ctx: MeasureContext,
  config: {
    storageAdapter: StorageAdapter
    accountsUrl: string
    accountsUrlInternal?: string
    uploadUrl: string
    filesUrl: string
    modelVersion: string
    version: string
    rekoniUrl: string
    telegramUrl: string
    gmailUrl: string
    calendarUrl: string
    brandingUrl?: string
    previewUrl?: string
    linkPreviewUrl?: string
    pushPublicKey?: string
    disableSignUp?: string
    hideLocalLogin?: string
    streamUrl?: string
    billingUrl?: string
    paymentUrl?: string
    hulylakeUrl?: string
    datalakeUrl?: string
  },
  port: number,
  extraConfig?: Record<string, string | undefined>
): () => void {
  const app = express()

  const tempFileDir = mkdtempSync(join(tmpdir(), 'front-'))

  function cleanupTempFiles (): void {
    const maxAge = 1000 * 60 * 60 // 1 hour
    fs.readdir(tempFileDir, (err, files) => {
      if (err != null) return
      files.forEach((file) => {
        const filePath = join(tempFileDir, file)
        fs.stat(filePath, (err, stats) => {
          if (err != null) return
          if (Date.now() - stats.mtime.getTime() > maxAge) {
            fs.unlink(filePath, () => {})
          }
        })
      })
    })
  }

  setInterval(cleanupTempFiles, 1000 * 60 * 15) // Run every 15 minutes

  app.use(cors())
  app.use(
    fileUpload({
      useTempFiles: true,
      tempFileDir
    })
  )
  app.use(bp.json())
  app.use(bp.urlencoded({ extended: true }))

  const childLogger = ctx.logger.childLogger?.('requests', {
    enableConsole: 'true'
  })
  const requests = ctx.newChild('requests', {}, { logger: childLogger, span: false })

  class MyStream {
    write (text: string): void {
      requests.info(text)
    }
  }

  const myStream = new MyStream()

  // One line per asset request drowns everything else - a sanity run leaves 45k of them and no
  // errors. Log the requests that failed; ACCESS_LOG=all brings the rest back when needed.
  const accessLogAll = process.env.ACCESS_LOG === 'all'
  app.use(
    morgan('short', {
      stream: myStream,
      skip: (_req, res) => !accessLogAll && res.statusCode < 400
    })
  )

  const data = {
    ACCOUNTS_URL: config.accountsUrl,
    UPLOAD_URL: config.uploadUrl,
    FILES_URL: config.filesUrl,
    MODEL_VERSION: config.modelVersion,
    VERSION: config.version,
    REKONI_URL: config.rekoniUrl,
    TELEGRAM_URL: config.telegramUrl,
    GMAIL_URL: config.gmailUrl,
    CALENDAR_URL: config.calendarUrl,
    LINK_PREVIEW_URL: config.linkPreviewUrl,
    STREAM_URL: config.streamUrl,
    BRANDING_URL: config.brandingUrl,
    PREVIEW_URL: config.previewUrl,
    PUSH_PUBLIC_KEY: config.pushPublicKey,
    DISABLE_SIGNUP: config.disableSignUp,
    HIDE_LOCAL_LOGIN: config.hideLocalLogin,
    BILLING_URL: config.billingUrl,
    PAYMENT_URL: config.paymentUrl,
    HULYLAKE_URL: config.hulylakeUrl,
    DATALAKE_URL: config.datalakeUrl,
    ...(extraConfig ?? {})
  }
  // `data` is built once at startup, so serialize it once too - res.json() would stringify the
  // same object on every request. The pre-set ETag also stops express re-hashing the body.
  const configJson = Buffer.from(JSON.stringify(data), 'utf8')
  const configEtag = `W/"${configJson.length.toString(16)}-${createHash('sha1')
    .update(configJson)
    .digest('base64')
    .substring(0, 27)}"`
  app.get('/config.json', (req, res) => {
    res.status(200)
    res.set('Content-Type', 'application/json; charset=utf-8')
    res.set('ETag', configEtag)
    res.set('Cache-Control', cacheControlNoCache)
    res.set('Connection', 'keep-alive')
    res.set('Keep-Alive', `timeout=${KEEP_ALIVE_TIMEOUT}, max=${KEEP_ALIVE_MAX}`)
    res.send(configJson)
  })

  app.get('/api/v1/statistics', (req, res) => {
    try {
      const token = req.query.token as string
      const payload = decodeToken(token)
      const admin = payload.extra?.admin === 'true'
      res.status(200)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Keep-Alive', 'timeout=5')
      res.setHeader('Cache-Control', cacheControlNoCache)

      const json = JSON.stringify({
        metrics: metricsAggregate((ctx as any).metrics),
        statistics: {
          activeSessions: {}
        },
        admin
      })
      res.end(json)
    } catch (err: any) {
      if (err instanceof TokenError) {
        res.status(401).send()
        return
      }
      ctx.error('statistics error', { err })
      Analytics.handleError(err)
      res.status(404).send()
    }
  })

  const dist = resolve(process.env.PUBLIC_DIR ?? cwd(), 'dist')
  console.log('serving static files from', dist)

  let brandingUrl: URL | undefined
  if (config.brandingUrl !== undefined) {
    try {
      brandingUrl = new URL(config.brandingUrl)
    } catch (e) {
      console.error('Invalid branding URL. Must be absolute URL.', e)
    }
  }

  const { limitBytes, maxEntryBytes } = staticCacheLimits()
  if (limitBytes > 0) {
    console.log('static memory cache', { limitMb: limitBytes / 1048576, maxFileMb: maxEntryBytes / 1048576 })
    app.use(staticMemoryCache(dist, limitBytes, maxEntryBytes))
  }

  app.use(
    expressStaticGzip(dist, {
      enableBrotli: true,
      orderPreference: ['br'],
      serveStatic: {
        cacheControl: true,
        dotfiles: 'allow',
        maxAge: '365d',
        etag: true,
        lastModified: true,
        index: false,
        setHeaders (res, path) {
          if (
            path.toLowerCase().includes('index.html') ||
            (brandingUrl !== undefined && path.toLowerCase().includes(brandingUrl.pathname))
          ) {
            res.setHeader('Cache-Control', cacheControlNoCache)
          }
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('Keep-Alive', `timeout=${KEEP_ALIVE_TIMEOUT}, max=${KEEP_ALIVE_MAX}`)
        }
      }
    })
  )

  const getWorkspaceIds = async (ctx: MeasureContext, token: string, path?: string): Promise<WorkspaceIds | null> => {
    const accountClient = getAccountClient(config.accountsUrlInternal ?? config.accountsUrl, token)
    const workspaceInfo = await accountClient.getWorkspaceInfo()
    const wsIds = {
      uuid: workspaceInfo.uuid,
      dataId: workspaceInfo.dataId,
      url: workspaceInfo.url
    }
    if (path === undefined) {
      return wsIds
    }

    const actualUuid = workspaceInfo.uuid
    const expectedUuid = path.split('/')[2]
    if (expectedUuid !== undefined && actualUuid !== expectedUuid) {
      ctx.error('Cannot validate uuid', {
        expectedUuid,
        actualUuid,
        path,
        workspaceUuid: workspaceInfo.uuid,
        workspaceDataId: workspaceInfo.dataId
      })
      return null
    }

    return wsIds
  }

  const filesHandler = async (req: Request<any>, res: Response<any>): Promise<void> => {
    await ctx.with(
      'handle-file',
      {},
      async (ctx) => {
        try {
          const cookies = ((req?.headers?.cookie as string) ?? '').split(';').map((it) => it.trim().split('='))

          const authorization = ((req?.headers?.authorization as string) ?? '').split(' ')
          const authorizationToken = authorization.at(0)?.toLowerCase() === 'bearer' ? authorization.at(1) : undefined
          const token =
            cookies.find((it) => it[0] === 'presentation-metadata-Token')?.[1] ??
            (req.query.token as string | undefined) ??
            authorizationToken ??
            ''
          const wsIds = await getWorkspaceIds(ctx, token, req.path)
          if (wsIds === null) {
            res.status(403).send()
            return
          }

          const uuid = req.params.file ?? req.query.file
          if (uuid === undefined) {
            res.status(404).send()
            return
          }

          const blobInfo = await ctx.with('stat', {}, (ctx) => config.storageAdapter.stat(ctx, wsIds, uuid), {
            workspace: wsIds.uuid
          })

          if (blobInfo === undefined) {
            ctx.error('No such key', { file: uuid, workspace: wsIds.uuid })
            res.status(404).send()
            return
          }

          if (req.method === 'HEAD') {
            res.writeHead(200, {
              'accept-ranges': 'bytes',
              connection: 'keep-alive',
              'Keep-Alive': 'timeout=5',
              'content-type': blobInfo.contentType,
              'content-length': blobInfo.size,
              'content-security-policy': "default-src 'none';",
              Etag: blobInfo.etag,
              'Last-Modified': new Date(blobInfo.modifiedOn).toISOString()
            })
            res.status(200)

            res.end()
            return
          }
          const range = req.headers.range
          if (range !== undefined) {
            await ctx.with(
              'file-range',
              {},
              (ctx) => getFileRange(ctx, blobInfo, range, config.storageAdapter, wsIds, res),
              { workspace: wsIds.uuid }
            )
          } else {
            await ctx.with('file', {}, (ctx) => getFile(ctx, blobInfo, config.storageAdapter, wsIds, req, res), {
              uuid,
              workspace: wsIds.uuid
            })
          }
        } catch (error: any) {
          if (error instanceof PlatformError && error.status.code === platform.status.Unauthorized) {
            res.status(401).send()
            return
          }
          if (
            error?.code === 'NoSuchKey' ||
            error?.code === 'NotFound' ||
            error?.message === 'No such key' ||
            error?.Code === 'NoSuchKey'
          ) {
            ctx.error('No such storage key', {
              file: req.query.file
            })
            res.status(404).send()
            return
          } else {
            ctx.error('error-handle-files', { error })
          }
          res.status(500).send()
        }
      },
      { url: req.path, query: req.query }
    )
  }

  app.get('/files', (req, res) => {
    void filesHandler(req, res)
  })

  app.head('/files/*', (req, res) => {
    void filesHandler(req, res)
  })

  app.get('/files/*', (req, res) => {
    void filesHandler(req, res)
  })

  app.post('/files', (req, res) => {
    void handleUpload(req, res)
  })

  app.post('/files/*', (req, res) => {
    void handleUpload(req, res)
  })

  const handleUpload = async (req: Request, res: Response): Promise<void> => {
    await ctx.with(
      'post-file',
      {},
      async (ctx) => {
        const file = req.files?.file as UploadedFile

        if (file === undefined) {
          res.status(400).send()
          return
        }

        const authHeader = req.headers.authorization
        if (authHeader === undefined) {
          res.status(403).send()
          return
        }

        try {
          const token = authHeader.split(' ')[1]
          const workspaceDataId = await getWorkspaceIds(ctx, token, req.path)
          if (workspaceDataId === null) {
            res.status(403).send()
            return
          }
          const { uuid, etag } = await storageUpload(ctx, config.storageAdapter, workspaceDataId, file)

          res.status(200).send([
            {
              key: 'file',
              id: uuid,
              metadata: {
                name: uuid,
                etag,
                size: file.size,
                contentType: file.mimetype,
                lastModified: Date.now()
              }
            }
          ])
        } catch (error: any) {
          if (error instanceof PlatformError && error.status.code === platform.status.Unauthorized) {
            res.status(401).send()
            return
          }
          ctx.error('error-post-files', error)
          res.status(500).send()
        }
      },
      { url: req.path, query: req.query }
    )
  }

  const handleDelete = async (req: Request, res: Response): Promise<void> => {
    try {
      const authHeader = req.headers.authorization
      if (authHeader === undefined) {
        res.status(403).send()
        return
      }

      const token = authHeader.split(' ')[1]
      const workspaceDataId = await getWorkspaceIds(ctx, token, req.path)
      if (workspaceDataId === null) {
        res.status(403).send()
        return
      }
      const uuid = req.query.file as string
      if (uuid === '') {
        res.status(500).send()
        return
      }

      // TODO: We need to allow delete only of user attached documents. (https://front.hc.engineering/workbench/platform/tracker/TSK-1081)
      await config.storageAdapter.remove(ctx, workspaceDataId, [uuid])

      res.status(200).send()
    } catch (error: any) {
      if (error instanceof PlatformError && error.status.code === platform.status.Unauthorized) {
        res.status(401).send()
        return
      }
      Analytics.handleError(error)
      ctx.error('failed to delete', { url: req.url })
      res.status(500).send()
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.delete('/files', handleDelete)

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.delete('/files/*', handleDelete)

  const filesPatterns = [
    '.js',
    '.js.gz',
    'js.map',
    'js.map.gz',
    '.woff',
    '.woff2',
    '.svg.gz',
    '.css',
    '.css.gz',
    '.ico',
    '.svg',
    '.webp',
    '.png',
    '.avif'
  ]

  app.get('*', (request, response) => {
    const safePath = normalize(join(dist, request.path))
    if (!safePath.startsWith(dist)) {
      response.sendStatus(403)
      return
    }
    if (filesPatterns.some((it) => request.path.endsWith(it))) {
      response.sendStatus(404)
      return
    }
    response.sendFile(join(dist, request.accepts().includes('gzip') ? 'index.html.gz' : 'index.html'), {
      etag: true,
      lastModified: true,
      cacheControl: false,
      headers: {
        'Cache-Control': cacheControlNoCache,
        'Keep-Alive': `timeout=${KEEP_ALIVE_TIMEOUT}, max=${KEEP_ALIVE_MAX}`
      }
    })
  })

  const server = app.listen(port)
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 1000
  server.headersTimeout = KEEP_ALIVE_TIMEOUT * 1000 + 2000
  return () => {
    server.close()
  }
}
