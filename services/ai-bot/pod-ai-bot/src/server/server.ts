//
// Copyright © 2024 Hardcore Engineering Inc.
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
import { Token } from '@hcengineering/server-token'
import cors from 'cors'
import express, { type Express, type NextFunction, type Request, type Response, raw } from 'express'
import { type Server } from 'http'
import { Readable } from 'stream'
import {
  TranslateRequest,
  ConnectMeetingRequest,
  DisconnectMeetingRequest,
  AIEventRequest,
  PostTranscriptRequest,
  SummarizeMessagesRequest
} from '@hcengineering/ai-bot'
import { extractToken, getAccountClient, readToken } from '@hcengineering/server-client'
import { AccountRole, type Doc, MeasureContext, type Ref, systemAccountUuid } from '@hcengineering/core'
import { isWorkspaceLoginInfo } from '@hcengineering/account-client'

import { ApiError } from './error'
import { AIControl } from '../controller'
import config from '../config'
import { availableLevels } from '../llms/modelRegistry'
import { availableAsrLevels } from '../transcription/asrRegistry'
import type { AILevelInfo, AsrLevelInfo } from '@hcengineering/ai-bot'

type AsyncRequestHandler = (req: Request, res: Response, token: Token, next: NextFunction) => Promise<void>

const handleRequest = async (
  fn: AsyncRequestHandler,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = extractToken(req.headers)
  if (token === undefined) {
    throw new ApiError(401)
  }
  try {
    await fn(req, res, token, next)
  } catch (err: unknown) {
    next(err)
  }
}

const wrapRequest = (fn: AsyncRequestHandler) => (req: Request, res: Response, next: NextFunction) => {
  void handleRequest(fn, req, res, next)
}

// Resolve the caller's workspace role from the raw bearer token. Fail-closed on any error.
const isWorkspaceOwner = async (req: Request): Promise<boolean> => {
  const raw = readToken(req.headers)
  if (raw === undefined) return false
  try {
    const info = await getAccountClient(raw).getLoginInfoByToken()
    return isWorkspaceLoginInfo(info) && info.role === AccountRole.Owner
  } catch {
    return false
  }
}

export function createServer (controller: AIControl, ctx: MeasureContext, app?: Express): Express {
  if (app === undefined) {
    app = express()
    app.use(cors())
  }
  app.use((req, res, next) => {
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Keep-Alive', 'timeout=5, max=1000')
    next()
  })

  // Raw body parser for /love/send_raw endpoint (must be before express.json())
  // Supports both legacy gzip (application/octet-stream) and new opus (audio/ogg) formats
  app.use('/love/send_raw', raw({ type: ['application/octet-stream', 'audio/ogg'], limit: '10mb' }))

  // Note: /love/send_session uses streaming, no body parser needed

  app.use(express.json())

  app.post(
    '/translate',
    wrapRequest(async (req, res, token) => {
      if (req.body == null || Array.isArray(req.body) || typeof req.body !== 'object') {
        throw new ApiError(400)
      }
      const response = await controller.translate(token.workspace, req.body as TranslateRequest)
      if (response === undefined) {
        throw new ApiError(500)
      }

      res.status(200)
      res.json(response)
    })
  )

  app.post(
    '/summarize',
    wrapRequest(async (req, res, token) => {
      if (req.body == null || Array.isArray(req.body) || typeof req.body !== 'object') {
        throw new ApiError(400)
      }

      const request = req.body as SummarizeMessagesRequest
      if (request.target === undefined || request.targetClass === undefined) {
        throw new ApiError(400)
      }
      // Same queue as the automatic post-meeting summary: the job is long and about to grow into
      // several steps, so the button fires it off and the result lands in the document.
      controller.checkTokensLimit(token.workspace)
      const queued = await controller.queueSummary(token.workspace, {
        target: request.target,
        targetClass: request.targetClass,
        manual: true,
        lang: request.lang
      })
      if (!queued) {
        throw new ApiError(503)
      }

      res.status(202)
      res.json({})
    })
  )

  // The conversation transcript, as written after every reply: the download button serves this
  // file, so what the user gets is exactly what the model is given (tool calls included).
  app.get(
    '/conversation/:id/export',
    wrapRequest(async (req, res, token) => {
      const conversation = req.params.id
      if (conversation === undefined || conversation === '') {
        throw new ApiError(400)
      }
      const mdx = await controller.exportConversation(token.workspace, conversation as Ref<Doc>)
      if (mdx === undefined) {
        throw new ApiError(404)
      }
      res.status(200)
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.send(mdx)
    })
  )

  app.post(
    '/connect',
    wrapRequest(async (_, res, token) => {
      ctx.info('Request to connect to workspace', { workspace: token.workspace })
      await controller.connect(token.workspace)

      res.status(200)
      res.json({})
    })
  )

  app.post(
    '/events',
    wrapRequest(async (req, res, token) => {
      if (req.body == null) {
        throw new ApiError(400)
      }

      const events = Array.isArray(req.body) ? req.body : [req.body]

      await controller.processEvent(token.workspace, events as AIEventRequest[])

      res.status(200)
      res.json({})
    })
  )

  app.post(
    '/love/transcript',
    wrapRequest(async (req, res, token) => {
      if (req.body == null || Array.isArray(req.body) || typeof req.body !== 'object') {
        throw new ApiError(400)
      }

      // Diagnostics: log incoming request summary to help trace misrouted transcripts
      ctx.info('Incoming /love/transcript request', {
        token_account: token.account,
        token_workspace: token.workspace,
        roomName: (req.body as PostTranscriptRequest).roomName,
        participant: (req.body as PostTranscriptRequest).participant,
        transcriptLength: ((req.body as PostTranscriptRequest).transcript ?? '').length
      })

      if (token.account !== controller.personUuid) {
        ctx.info('Unauthorized /love/transcript request', { token_account: token.account })
        throw new ApiError(401)
      }

      try {
        await controller.processLoveTranscript(req.body as PostTranscriptRequest)
        ctx.info('Processed /love/transcript successfully', {
          roomName: (req.body as PostTranscriptRequest).roomName,
          participant: (req.body as PostTranscriptRequest).participant,
          transcriptLength: ((req.body as PostTranscriptRequest).transcript ?? '').length
        })
      } catch (err: any) {
        ctx.error('Error processing /love/transcript', {
          error: err?.message ?? String(err),
          bodyPreview: {
            roomName: (req.body as PostTranscriptRequest).roomName,
            participant: (req.body as PostTranscriptRequest).participant
          }
        })
        throw err
      }

      res.status(200)
      res.json({})
    })
  )

  app.post(
    '/love/connect',
    wrapRequest(async (req, res, token) => {
      if (req.body == null || Array.isArray(req.body) || typeof req.body !== 'object') {
        throw new ApiError(400)
      }

      const request: ConnectMeetingRequest = req.body
      await controller.loveConnect(token.workspace, request)

      res.status(200)
      res.json({})
    })
  )

  app.post(
    '/love/disconnect',
    wrapRequest(async (req, res, token) => {
      if (req.body == null || Array.isArray(req.body) || typeof req.body !== 'object') {
        throw new ApiError(400)
      }

      const request: DisconnectMeetingRequest = req.body
      await controller.loveDisconnect(token.workspace, request)

      res.status(200)
      res.json({})
    })
  )

  app.get(
    '/love/:roomName/identity',
    wrapRequest(async (req, res, token) => {
      if (token.account !== systemAccountUuid) {
        ctx.info('Request love identity failed', { token_account: token.account })
        throw new ApiError(401)
      }

      const roomName = req.params.roomName
      const resp = await controller.getLoveIdentity(roomName)

      if (resp === undefined) {
        ctx.info('Request love identity failed', { roomName })
        throw new ApiError(404)
      }

      res.status(200)
      res.json(resp)
    })
  )

  // The catalog of AI levels the pod offers (same for everyone). The UI uses this
  // to render the level picker; the chosen level is stored in AISpaceSettings.
  app.get(
    '/levels',
    wrapRequest(async (req, res, token) => {
      const levels: AILevelInfo[] = availableLevels(config.AIProviders).map((l) => ({
        level: l.level,
        order: l.order,
        label: l.label,
        tokenMultiplier: l.tokenMultiplier,
        displayMultiplier: l.displayMultiplier,
        features: l.features
      }))
      res.status(200)
      res.json(levels)
    })
  )

  // ASR transcription levels for the space settings picker (mirrors /levels).
  app.get(
    '/asr-levels',
    wrapRequest(async (req, res, token) => {
      const levels: AsrLevelInfo[] = availableAsrLevels(config.AsrProviders).map((l) => ({
        level: l.level,
        order: l.order,
        label: l.label,
        tokenMultiplier: l.tokenMultiplier,
        displayMultiplier: l.displayMultiplier
      }))
      res.status(200)
      res.json(levels)
    })
  )

  // Set the workspace-wide AI level (AISpaceSettings without attachedTo).
  // Workspace owners only; system tokens (tests/tooling) bypass the role check.
  app.post(
    '/levels/workspace',
    wrapRequest(async (req, res, token) => {
      if (token.account !== systemAccountUuid && !(await isWorkspaceOwner(req))) {
        throw new ApiError(403, 'Only workspace owners can change the AI level')
      }
      const level = req.body?.level
      if (typeof level !== 'string' || level === '') {
        throw new ApiError(400, 'level is required')
      }
      if (!availableLevels(config.AIProviders).some((l) => l.level === level)) {
        throw new ApiError(400, `unknown level: ${level}`)
      }
      await controller.setWorkspaceLevel(token.workspace, level)
      res.status(200)
      res.json({ level })
    })
  )

  app.post(
    '/love/send_raw',
    wrapRequest(async (req, res, token) => {
      // Accept tokens from love-agent (systemAccountUuid) or ai-bot itself
      if (token.account !== systemAccountUuid && token.account !== controller.personUuid) {
        throw new ApiError(401)
      }

      if (!Buffer.isBuffer(req.body)) {
        throw new ApiError(400, 'Expected binary body')
      }

      const roomNameRaw = req.headers['x-room-name'] as string | undefined
      const roomName = roomNameRaw !== undefined ? decodeURIComponent(roomNameRaw) : undefined
      const participant = req.headers['x-participant'] as string | undefined
      const startTimeSec = parseFloat((req.headers['x-start-time'] as string) ?? '0')
      const endTimeSec = parseFloat((req.headers['x-end-time'] as string) ?? '0')
      const durationSec = parseFloat((req.headers['x-duration'] as string) ?? '0')
      const hasSpeech = req.headers['x-has-speech'] === 'true'
      const speechRatio = parseFloat((req.headers['x-speech-ratio'] as string) ?? '0')
      const peakAmplitude = parseFloat((req.headers['x-peak-amplitude'] as string) ?? '0')
      const rmsAmplitude = parseFloat((req.headers['x-rms-amplitude'] as string) ?? '0')
      const sampleRate = parseInt((req.headers['x-sample-rate'] as string) ?? '16000', 10)
      const channels = parseInt((req.headers['x-channels'] as string) ?? '1', 10)
      const bitsPerSample = parseInt((req.headers['x-bits-per-sample'] as string) ?? '16', 10)
      const audioFormat = ((req.headers['x-audio-format'] as string) ?? 'ogg') as 'ogg' | 'wav'

      if (roomName === undefined || participant === undefined) {
        throw new ApiError(400, 'Missing required headers: X-Room-Name, X-Participant')
      }

      await controller.processAudioChunk(req.body, {
        roomName,
        participant,
        startTimeSec,
        endTimeSec,
        durationSec,
        hasSpeech,
        speechRatio,
        peakAmplitude,
        rmsAmplitude,
        sampleRate,
        channels,
        bitsPerSample,
        audioFormat
      })

      res.status(200)
      res.json({})
    })
  )

  app.post(
    '/love/send_session',
    wrapRequest(async (req, res, token) => {
      // Accept tokens from love-agent (systemAccountUuid) or ai-bot itself
      if (token.account !== systemAccountUuid && token.account !== controller.personUuid) {
        throw new ApiError(401)
      }

      const roomNameRaw = req.headers['x-room-name'] as string | undefined
      const roomName = roomNameRaw !== undefined ? decodeURIComponent(roomNameRaw) : undefined
      const participant = req.headers['x-participant'] as string | undefined
      const participantNameRaw = req.headers['x-participant-name'] as string | undefined
      const participantName = participantNameRaw !== undefined ? decodeURIComponent(participantNameRaw) : undefined
      const startTimeSec = parseFloat((req.headers['x-start-time'] as string) ?? '0')
      const endTimeSec = parseFloat((req.headers['x-end-time'] as string) ?? '0')
      const sessionNumber = parseInt((req.headers['x-session-number'] as string) ?? '1', 10)
      const contentLength = parseInt((req.headers['content-length'] as string) ?? '0', 10)

      if (roomName === undefined || participant === undefined) {
        throw new ApiError(400, 'Missing required headers: X-Room-Name, X-Participant')
      }

      // Pass request stream directly to controller
      await controller.processSessionRecording(req as Readable, {
        roomName,
        participant,
        participantName: participantName ?? participant,
        startTimeSec,
        endTimeSec,
        sessionNumber,
        size: contentLength
      })

      res.status(200)
      res.json({})
    })
  )

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.log(err)
    if (err instanceof ApiError) {
      res.status(err.code).send({ code: err.code, message: err.message })
      return
    }

    res.status(500).send(err.message?.length > 0 ? { message: err.message } : err)
  })

  return app
}

export function listen (e: Express, port: number, host?: string): Server {
  const cb = (): void => {
    console.log(`AI service has been started at ${host ?? '*'}:${port}`)
  }

  return host !== undefined ? e.listen(port, host, cb) : e.listen(port, cb)
}
