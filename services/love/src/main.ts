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
import {
  getClient as getAccountClientRaw,
  isWorkspaceLoginInfo,
  type AccountClient
} from '@hcengineering/account-client'
import { createOpenTelemetryMetricsContext, SplitLogger } from '@hcengineering/analytics-service'
import {
  AccountRole,
  type Doc,
  MeasureContext,
  newMetrics,
  type Ref,
  systemAccountUuid,
  type Tx,
  type TxCUD,
  WorkspaceUuid
} from '@hcengineering/core'
import { type Person } from '@hcengineering/contact'
import {
  loveId,
  MeetingStatus,
  parseRoomName,
  ParticipantMetadata,
  queueEvents,
  QueueMeetingEvent,
  QueueMeetingMessage,
  QueueMeetingUpdateMetadataMessage,
  QueueWebhookMeetingMessage,
  RoomMetadata,
  TranscriptionState
} from '@hcengineering/love'
import { setMetadata } from '@hcengineering/platform'
import serverClient from '@hcengineering/server-client'

import { getPlatformQueue } from '@hcengineering/kafka'
import {
  initStatisticsContext,
  QueueTopic,
  QueueWorkspaceEvent,
  type QueueWorkspaceMessage,
  StorageConfig,
  StorageConfiguration
} from '@hcengineering/server-core'
import { storageConfigFromEnv } from '@hcengineering/server-storage'
import serverToken, { decodeToken, generateToken } from '@hcengineering/server-token'
import cors from 'cors'
import express, { type Request } from 'express'
import {
  EgressClient,
  RoomAgentDispatch,
  RoomServiceClient,
  WebhookReceiver,
  type WebhookEvent
} from 'livekit-server-sdk'
import { join } from 'path'
import { updateLiveKitSessions } from './billing'
import config from './config'
import { LiveKitPollingService } from './polling'
import { claimSession, liveSessionsOf } from './sessions'
import { LimitsState } from './limits'
import { RecordingProcessor } from './recordings'
import { WebhookProcessor } from './webhook'
import { WorkspaceClient } from './workspaceClient'
import { GuestManager } from './guests'
import { createToken, decodeMeetingToken, extractToken, getRoomName, getWorkspaceId, updateMetadata } from './utils'
import { setBillingProducer, type BillingMessage } from './queue'
/**
 * Recursively converts all BigInt values in an object to strings.
 * This is needed because JSON.stringify cannot handle BigInt values.
 */
function convertBigIntToString (obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj
  }
  if (typeof obj === 'bigint') {
    return obj.toString()
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToString)
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertBigIntToString(value)
    }
    return result
  }
  return obj
}

const ACTIVE_WORKSPACES_SYNC_MS = 5 * 60 * 1000

// Prefix match covers every love class and mixin (loveId === 'love'), including future ones.
function isLoveTx (tx: Tx): boolean {
  return (tx as TxCUD<Doc>).objectClass?.startsWith(`${loveId}:`) ?? false
}

function getAccountClient (token?: string): AccountClient {
  return getAccountClientRaw(config.AccountsURL, token)
}

export function getWebhookRoomName (event: WebhookEvent): string | undefined {
  if (event.egressInfo != null && typeof event.egressInfo.roomName === 'string') return event.egressInfo.roomName
  if (typeof (event as any).roomName === 'string') return (event as any).roomName
  if (event.room != null && typeof event.room.name === 'string') return event.room.name
  return undefined
}

export const main = async (): Promise<void> => {
  setMetadata(serverClient.metadata.Endpoint, config.AccountsURL)
  setMetadata(serverClient.metadata.UserAgent, config.ServiceID)
  setMetadata(serverToken.metadata.Secret, config.Secret)
  setMetadata(serverToken.metadata.Service, 'love')

  const storageConfigs: StorageConfiguration = storageConfigFromEnv()
  const s3StorageConfigs: StorageConfiguration | undefined =
    config.S3StorageConfig !== undefined ? storageConfigFromEnv(config.S3StorageConfig) : undefined

  const queue = getPlatformQueue('love-client')

  const ctx = initStatisticsContext('love', {
    factory: () =>
      createOpenTelemetryMetricsContext(
        'love',
        {},
        {},
        newMetrics(),
        new SplitLogger('love', {
          root: join(process.cwd(), 'logs'),
          enableConsole: (process.env.ENABLE_CONSOLE ?? 'true') === 'true'
        })
      )
  })

  const storageConfig = storageConfigs.storages.find((it) => ['datalake', 's3'].includes(it.kind))
  const s3storageConfig = s3StorageConfigs?.storages.findLast((p) => p.kind === 's3')

  const app = express()
  const port = config.Port
  app.use(cors())
  app.use(express.raw({ type: 'application/webhook+json' }))
  app.use(express.json())

  const roomClient = new RoomServiceClient(config.LiveKitHost, config.ApiKey, config.ApiSecret)
  const egressClient = new EgressClient(config.LiveKitHost, config.ApiKey, config.ApiSecret, {
    requestTimeout: config.EgressRequestTimeoutSec
  })

  const eventProducer = queue.getProducer<QueueMeetingMessage>(ctx, QueueTopic.LoveQueue)
  const billingProducer = queue.getProducer<BillingMessage>(ctx, QueueTopic.BillingUsage)
  setBillingProducer(billingProducer)

  // Disk/payment-exhausted workspaces (LimitsChanged consumer) — gate for starting recordings.
  const limitsState = new LimitsState(ctx, queue)

  const webhookProcessor = new WebhookProcessor(
    ctx,
    roomClient,
    eventProducer,
    egressClient,
    storageConfig,
    s3storageConfig
  )

  const recordingProcessor = new RecordingProcessor(
    ctx.newChild('recordings', {}),
    roomClient,
    eventProducer,
    egressClient,
    storageConfig,
    s3storageConfig,
    limitsState
  )

  const guestManager = new GuestManager(ctx, roomClient)

  const receivers = [new WebhookReceiver(config.ApiKey, config.ApiSecret)]

  if (config.LiveKitWebhookKey !== '' && config.LiveKitWebhookSecret !== '') {
    receivers.push(new WebhookReceiver(config.LiveKitWebhookKey, config.LiveKitWebhookSecret))
  }

  async function decodeEvent (req: Request): Promise<WebhookEvent> {
    for (const r of receivers) {
      try {
        return await r.receive(req.body, req.get('Authorization'))
      } catch (e) {
        // Ignore
      }
    }
    throw new Error('Failed to decode webhook event with all receivers')
  }

  const eventConsumer = queue.createConsumer(ctx, QueueTopic.LoveQueue, 'love-webhook-producer', async (ctx, msg) => {
    const queueMsg = msg.value as QueueMeetingMessage
    switch (queueMsg.type) {
      case QueueMeetingEvent.webhook: {
        const event = (queueMsg as QueueWebhookMeetingMessage).webhook
        await ctx.with('handle-webhook', {}, () =>
          webhookProcessor.processEvent(event, {
            meetingId: queueMsg.meetingId,
            workspace: msg.workspace
          })
        )
        break
      }
      case QueueMeetingEvent.updateMetadata: {
        const metadataMsg = queueMsg as QueueMeetingUpdateMetadataMessage
        await updateMetadata(ctx, roomClient, metadataMsg.roomName, metadataMsg.metadata)
        break
      }
      case QueueMeetingEvent.started: {
        const wsClient = await WorkspaceClient.create(msg.workspace, ctx)
        const mm = await wsClient.findMeetingById(queueMsg.meetingId)
        if (mm !== undefined && mm.startWithRecording === true) {
          const sysToken = generateToken(systemAccountUuid, msg.workspace, { service: 'love' })
          const wsLoginInfo = await getAccountClient(sysToken).getLoginInfoByToken()
          if (!isWorkspaceLoginInfo(wsLoginInfo)) {
            break
          }
          await recordingProcessor.startRecording(
            getRoomName(msg.workspace, queueMsg.meetingId),
            msg.workspace,
            queueMsg.meetingId,
            wsLoginInfo,
            mm.name
          )
        }
        break
      }
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/webhook', async (req, res) => {
    try {
      const rawEvent: WebhookEvent = await decodeEvent(req)
      // Convert all BigInt values to strings to prevent serialization errors throughout the handler
      const event = convertBigIntToString(rawEvent) as typeof rawEvent

      if (event.room?.metadata != null && event.room?.metadata !== '') {
        try {
          const metadata = JSON.parse(event.room.metadata) as RoomMetadata
          if (metadata.projectKey != null && metadata.projectKey !== config.LiveKitProject) {
            ctx.info('Ignoring event from different project', { eventProjectKey: metadata.projectKey })
            return
          }
        } catch (err: any) {
          ctx.error('Failed to parse room metadata', { error: err, room: JSON.stringify(event?.room, null, 2) })
        }
      }

      const roomStr = getWebhookRoomName(event)
      if (roomStr === undefined) {
        console.warn('No roomName available in event', { event: event.event })
        return
      }

      const roomName = parseRoomName(roomStr)
      if (roomName === undefined) {
        ctx.info('Skipping event: invalid room name format', { roomName: roomStr, event: event.event })

        return
      }

      // A webhook means the stand is not idle any more - drop the polling back-off.
      pollingService.wakeUp()
      await eventProducer.send(ctx, roomName.workspace, [queueEvents.webhook(roomName.meetingId, event)])
    } catch (e) {
      ctx.error('Failed to process webhook event', { error: e })
    } finally {
      res.status(200).send() // We should always say event is received
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/getToken', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    // Check access to private meetings
    try {
      const token = extractToken(req.headers)
      if (token === undefined) {
        res.status(401).send()
        return
      }
      const decoded = decodeToken(token)
      const accountUuid = decoded.account

      // System accounts always have access
      if (accountUuid !== systemAccountUuid) {
        const wsClient = await WorkspaceClient.create(workspaceId, ctx)
        const meetingDoc = await wsClient.findMeetingById(meetingId)
        // A token for a Finished meeting recreates its LiveKit room, and the client ends up
        // connected to a room the `meetings` store filters out - no UI state at all.
        if (meetingDoc?.status === MeetingStatus.Finished) {
          ctx.warn('Token requested for a finished meeting', { meetingId, account: accountUuid })
          res.status(409).send({ error: 'Meeting is finished' })
          return
        }
        if (meetingDoc !== undefined && meetingDoc.private && !meetingDoc.members.includes(accountUuid)) {
          // Owners bypass private-meeting membership; rechecked here in case the client's self-add races or fails.
          let isWorkspaceOwner = false
          try {
            const wsLoginInfo = await getAccountClient(token).getLoginInfoByToken()
            isWorkspaceOwner = isWorkspaceLoginInfo(wsLoginInfo) && wsLoginInfo.role === AccountRole.Owner
          } catch (err: any) {
            ctx.warn('Failed to resolve role for owner-bypass check', {
              error: err?.message ?? String(err),
              account: accountUuid
            })
          }
          if (!isWorkspaceOwner) {
            ctx.warn('Access denied to private meeting', { meetingId, account: accountUuid })
            res.status(403).send({ error: 'Access denied to private meeting' })
            return
          }
        }
      }
    } catch (err: any) {
      ctx.error('Failed to check meeting access', { error: err?.message ?? String(err) })
      res.status(401).send()
      return
    }

    const _id = req.body._id
    if (typeof _id !== 'string' || _id === '') {
      res.status(400).send({ error: 'Missing participant id' })
      return
    }
    const participantName = req.body.participantName
    // No sentinel: a numeric fallback reaches getFreeRoomPlace as a real seat preference.
    const x = typeof req.body.x === 'number' ? req.body.x : undefined
    const y = typeof req.body.y === 'number' ? req.body.y : undefined
    const roomName = getRoomName(workspaceId, meetingId)

    const room = await roomClient.listRooms([roomName])
    // TODO: Retry creation
    if (room === undefined || room.length === 0) {
      ctx.info('Creating room', { roomName })
      const roomMetadata: RoomMetadata = {
        projectKey: config.LiveKitProject,
        workspaceId,
        meetingId
      }
      try {
        await roomClient.createRoom({
          metadata: JSON.stringify(roomMetadata),
          // A page refresh or a short network drop must not read as leaving the meeting.
          departureTimeout: config.DepartureTimeoutSec,
          name: roomName,
          agents: config.Agents.map((it) => new RoomAgentDispatch({ agentName: it }))
        })
      } catch (err: any) {
        console.error('Error creating room:', err)
      }
    }

    res.send(
      await createToken(
        roomName,
        _id,
        participantName,
        JSON.stringify({
          x,
          y
        } satisfies ParticipantMetadata)
      )
    )
  })

  /** The Person of whoever holds the bearer token, so a request can never act as someone else. */
  async function resolveCaller (req: Request, workspaceId: WorkspaceUuid): Promise<Ref<Person> | undefined> {
    const token = extractToken(req.headers)
    if (token === undefined) return undefined
    const account = decodeToken(token).account
    const wsClient = await WorkspaceClient.create(workspaceId, ctx)
    return await wsClient.findPersonByAccount(account)
  }

  // Answers "am I really still in these meetings?" - a ParticipantInfo row outlives a closed tab,
  // so the client cannot tell a live second session from a leftover on its own.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/liveSessions', async (req, res) => {
    const workspaceId = getWorkspaceId(req)
    const candidates = req.body.meetings
    if (workspaceId === undefined) {
      res.status(401).send()
      return
    }
    if (!Array.isArray(candidates)) {
      res.status(400).send({ error: 'Missing meetings' })
      return
    }
    try {
      const person = await resolveCaller(req, workspaceId)
      if (person === undefined) {
        res.status(403).send({ error: 'No person for this account' })
        return
      }
      const meetings = await liveSessionsOf(ctx, roomClient, workspaceId, person, candidates)
      res.send({ meetings })
    } catch (err: any) {
      // Fail closed: an unknown answer must not pop a dialog about a meeting nobody is in.
      ctx.warn('Failed to list live sessions', { error: err?.message ?? String(err) })
      res.send({ meetings: [] })
    }
  })

  // Called once the client is really connected: only then is it safe to drop the person's other
  // sessions, which are what keeps an abandoned room occupied (see `claimSession`).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/claimSession', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }
    try {
      // Never the `_id` the client sends: that would let anyone evict anybody else's sessions.
      const person = await resolveCaller(req, workspaceId)
      if (person === undefined) {
        res.status(403).send({ error: 'No person for this account' })
        return
      }
      const wsClient = await WorkspaceClient.create(workspaceId, ctx)
      const evicted = await claimSession(ctx, roomClient, wsClient, workspaceId, person, meetingId)
      res.send({ evicted })
    } catch (err: any) {
      // Never fail the join over housekeeping.
      ctx.warn('Failed to claim a session', { error: err?.message ?? String(err), meetingId })
      res.send({ evicted: 0 })
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/guestToken', async (req, res) => {
    await guestManager.handleGuestToken(req, res)
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/guestInfo', async (req, res) => {
    await guestManager.handleGuestInfo(req, res)
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/guestJoin', async (req, res) => {
    await guestManager.handleGuestJoin(req, res)
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.get('/checkRecordAvailable', async (_req, res) => {
    res.send(await checkRecordAvailable(ctx, storageConfig, s3storageConfig))
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/startRecord', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    const roomName = getRoomName(workspaceId, meetingId)

    // No disk left (or unpaid) — reject with a clear status instead of silently skipping.
    if (limitsState.isExhausted(workspaceId)) {
      res.status(413).send({ error: 'Storage limit exceeded' })
      return
    }

    try {
      const token = extractToken(req.headers)
      const wsLoginInfo = await getAccountClient(token).getLoginInfoByToken()
      if (!isWorkspaceLoginInfo(wsLoginInfo)) {
        console.error('No workspace found for the token')
        res.status(401).send()
        return
      }

      const verdict = await recordingProcessor.startRecording(
        roomName,
        workspaceId,
        meetingId,
        wsLoginInfo,
        // The client sends `title`; `name` stays for older callers and the sanity tests.
        req.body.title ?? req.body.name ?? 'recording'
      )
      if (!verdict.started) {
        // 409 so the second person to press the button sees the refusal instead of a fake success.
        res.status(verdict.reason === 'no-room' ? 404 : 409).send({ error: verdict.reason })
        return
      }
      res.send()
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/stopRecord', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    const roomName = getRoomName(workspaceId, meetingId)

    try {
      const verdict = await recordingProcessor.stopRecording(roomName, workspaceId, meetingId)
      if (!verdict.stopped) {
        res.status(verdict.reason === 'no-room' ? 404 : 409).send({ error: verdict.reason })
        return
      }
      res.send()
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/transcription', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    const roomName = getRoomName(workspaceId, meetingId)

    const language = req.body.language
    const transcription = req.body.transcription ?? false

    if (typeof roomName !== 'string') {
      res.status(400).send()
      return
    }

    try {
      // Check if LiveKit room exists before updating transcription
      const existingRooms = await roomClient.listRooms([roomName])
      if (existingRooms === undefined || existingRooms.length === 0) {
        ctx.warn('Cannot update transcription: LiveKit room does not exist', { roomName })
        res.status(404).send({ error: 'Room does not exist. Please ensure participants have joined the meeting.' })
        return
      }

      const metadata = language != null ? { transcription, language } : { transcription }
      await eventProducer.send(ctx, workspaceId, [queueEvents.updateMetadata(meetingId, roomName, metadata)])

      // The UI reads this document; without a deployed ai-bot nothing else would flip it.
      await (
        await WorkspaceClient.create(workspaceId, ctx)
      ).updateMeetingTranscriptionState(
        meetingId,
        transcription === true ? TranscriptionState.Transcribing : TranscriptionState.Finished
      )

      // Start/stop audio recording alongside transcription
      if (transcription === true) {
        const sysToken = generateToken(systemAccountUuid, workspaceId, { service: 'love' })
        const wsLoginInfo = await getAccountClient(sysToken).getLoginInfoByToken()
        if (isWorkspaceLoginInfo(wsLoginInfo)) {
          await recordingProcessor.startAudioRecording(roomName, workspaceId, meetingId, wsLoginInfo)
        }
      } else {
        void recordingProcessor.stopAudioRecording(roomName, workspaceId, meetingId)
      }

      res.status(200).send()
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/language', async (req, res) => {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    const roomName = getRoomName(workspaceId, meetingId)

    const language = req.body.language

    try {
      await eventProducer.send(ctx, workspaceId, [
        queueEvents.updateMetadata(meetingId, roomName, {
          language
        })
      ])
      res.send()
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  })

  // Initialize polling service if enabled
  const pollingService = new LiveKitPollingService(
    ctx,
    roomClient,
    {
      intervalMs: config.PollingIntervalMs,
      projectKey: config.LiveKitProject,
      ownerRejoinGraceMs: config.OwnerRejoinGraceSec * 1000
    },
    billingProducer,
    egressClient
  )
  pollingService.start()

  const workspaceConsumer = queue.createConsumer<QueueWorkspaceMessage>(
    ctx,
    QueueTopic.Workspace,
    'love-client',
    async (ctx, msg, queue) => {
      // Checking back on 'down' reopens the workspace, which closes and re-sends 'down' - endless loop.
      if (msg.value?.type === QueueWorkspaceEvent.Down) return
      pollingService.addWorkspaceToCheck(msg.workspace)
    }
  )

  const workspaceTxConsumer = queue.createBatchConsumer<Tx>(
    ctx,
    QueueTopic.Tx,
    'love-client',
    async (ctx, msgs, queue) => {
      const workspaces = new Set<WorkspaceUuid>()
      for (const msg of msgs) {
        // Without the filter any tx in any workspace makes the transactor build a full pipeline.
        if (!isLoveTx(msg.value)) continue
        workspaces.add(msg.workspace)
      }
      for (const ws of workspaces) {
        pollingService.addWorkspaceToCheck(ws)
      }
    },
    { batchSize: 500, batchTimeout: 200 }
  )

  // Workspace events only fire on open/close, so a meeting hung before a love restart in an
  // already-open workspace would never be seen. These workspaces are open anyway - no extra pipelines.
  const syncActiveWorkspaces = async (): Promise<void> => {
    try {
      const token = generateToken(systemAccountUuid, undefined, { service: 'love' })
      const visitedDays = ACTIVE_WORKSPACES_SYNC_MS / (24 * 60 * 60 * 1000)
      const list = await getAccountClient(token).listWorkspaces(null, 'active', visitedDays)
      for (const ws of list) {
        pollingService.addWorkspaceToCheck(ws.uuid)
      }
    } catch (err: any) {
      ctx.error('[love] failed to list recently visited workspaces', { error: err?.message ?? String(err) })
    }
  }
  void syncActiveWorkspaces()
  const activeWorkspacesSyncHandle = setInterval(() => {
    void syncActiveWorkspaces()
  }, ACTIVE_WORKSPACES_SYNC_MS)

  ctx.info('LiveKit polling service started', {
    intervalMs: config.PollingIntervalMs,
    projectKey: config.LiveKitProject
  })

  const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}`)
  })

  const shutdown = (): void => {
    clearInterval(activeWorkspacesSyncHandle)
    void workspaceConsumer.close()
    void workspaceTxConsumer.close()
    void eventConsumer.close()
    void eventProducer.close()
    void billingProducer.close()
    void limitsState.close()
    void queue.shutdown()
    pollingService.stop()
    void WorkspaceClient.closeAll()
    server.close(() => process.exit())
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (e) => {
    console.error(e)
  })
  process.on('unhandledRejection', (e) => {
    console.error(e)
  })

  if (config.BillingUrl !== '' && config.UseGlobalLiveKit) {
    setInterval(
      () => {
        void updateLiveKitSessions(ctx).catch((error) => {
          ctx.error('failed to update livekit sessions', { error })
        })
      },
      config.BillingPollInterval * 60 * 1000
    )
    try {
      void updateLiveKitSessions(ctx)
    } catch {}
  }
}

const checkRecordAvailable = async (
  ctx: MeasureContext,
  storageConfig: StorageConfig | undefined,
  s3storageConfig: StorageConfig | undefined
): Promise<boolean> => {
  if (storageConfig !== undefined && storageConfig.kind === 's3') return true
  if (storageConfig !== undefined && storageConfig.kind === 'datalake' && s3storageConfig !== undefined) return true
  ctx.error('NO S3 storage config storage:', {
    storageConfig: storageConfig?.kind,
    s3storageConfig: s3storageConfig?.kind
  })
  return false
}
