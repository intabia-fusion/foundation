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

import { Readable } from 'stream'
import { isWorkspaceLoginInfo } from '@hcengineering/account-client'
import aiBot, {
  AIEventRequest,
  ConnectMeetingRequest,
  DisconnectMeetingRequest,
  IdentityResponse,
  PersonMessage,
  PostTranscriptRequest,
  SummarizeMessagesRequest,
  SummarizeMessagesResponse,
  TranslateRequest,
  TranslateResponse
} from '@hcengineering/ai-bot'
import core, {
  AccountUuid,
  MeasureContext,
  PersonId,
  Ref,
  type Space,
  SocialId,
  SortingOrder,
  toIdMap,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import love, { MeetingMinutes, parseRoomName } from '@hcengineering/love'
import contact, { Person, Contact, SocialIdentityRef } from '@hcengineering/contact'
import chunter, { ChatMessage } from '@hcengineering/chunter'
import { getAccountClient, getTransactorEndpointEx } from '@hcengineering/server-client'
import { generateToken } from '@hcengineering/server-token'
import { htmlToMarkup, jsonToHTML, jsonToMarkup, markupToJSON } from '@hcengineering/text'
import { createDefaultProvider, createProvidersFromRegistry, type LLMProvider } from './llms'
import { ClisrServer } from '@intabiafusion/clisr'

import { ConsumerControl, PlatformQueueProducer, StorageAdapter } from '@hcengineering/server-core'
import { buildStorageFromConfig, storageConfigFrom } from '@hcengineering/server-storage'
import config, { type AILevel } from './config'
import { TranscriptionTask } from './types'
import { v4 as uuid } from 'uuid'
import { markdownToMarkup, markupToMarkdown } from '@hcengineering/text-markdown'
import { tryAssignToWorkspace } from './utils/account'
import { LimitsState } from './limits'
import { PoolLimits } from './billing'
import { resolveModel } from './llms/modelRegistry'
import { cheapestEligible } from './workspace/windowLimit'
import { ApiError } from './server/error'
/* LLM helpers moved to ./llm; use provider methods on `this.llm` instead */
import { WorkspaceClient } from './workspace/workspaceClient'

/** Audio format type */
export type AudioFormat = 'ogg' | 'wav'

/** Audio chunk metadata from HTTP headers */
export interface AudioChunkMetadata {
  roomName: string
  participant: string
  startTimeSec: number
  endTimeSec: number
  durationSec: number
  hasSpeech: boolean
  speechRatio: number
  peakAmplitude: number
  rmsAmplitude: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  audioFormat: AudioFormat
}

/** Session recording metadata from HTTP headers */
export interface SessionRecordingMetadata {
  roomName: string
  participant: string // Identity (Ref<Person>) for user identification
  participantName: string // Display name for files/attachments
  startTimeSec: number
  endTimeSec: number
  sessionNumber: number
  size: number
}

export class AIControl {
  private readonly workspaces: Map<WorkspaceUuid, WorkspaceClient> = new Map<WorkspaceUuid, WorkspaceClient>()
  private readonly connectingWorkspaces = new Map<WorkspaceUuid, Promise<void>>()

  // Workspace storage adapter
  readonly storageAdapter: StorageAdapter

  // Chunk storage adapter
  readonly chunkStorageAdapter: StorageAdapter
  private transcriptionProducer: PlatformQueueProducer<TranscriptionTask> | undefined

  private llm?: LLMProvider // default provider, used by service ops (translate/summarize)
  private providers = new Map<string, LLMProvider>() // per-provider, keyed by provider id (= topic suffix)
  private limitsState?: LimitsState
  private poolLimits?: PoolLimits

  constructor (
    readonly personUuid: AccountUuid,
    readonly socialIds: SocialId[],
    private readonly ctx: MeasureContext
  ) {
    this.storageAdapter = buildStorageFromConfig(storageConfigFrom(config.StorageConfig))
    this.chunkStorageAdapter = buildStorageFromConfig(storageConfigFrom(config.ChunkStorage))
  }

  /**
   * Initialize LLM provider. Can be called after construction to pass ClisrServer for server provider.
   */
  initLLM (clisrServer?: ClisrServer): void {
    this.providers = createProvidersFromRegistry(this.ctx, clisrServer)
    this.llm = createDefaultProvider(this.ctx, clisrServer)
  }

  /** All provider ids in the registry (= per-provider topic suffixes). */
  getProviderIds (): string[] {
    return [...this.providers.keys()]
  }

  /** Resolve a provider by id (the dispatcher routes by id via the topic). */
  getProvider (id: string): LLMProvider | undefined {
    return this.providers.get(id)
  }

  setTranscriptionProducer (producer: PlatformQueueProducer<TranscriptionTask>): void {
    this.transcriptionProducer = producer
  }

  setLimitsState (state: LimitsState): void {
    this.limitsState = state
  }

  setPoolLimits (pools: PoolLimits): void {
    this.poolLimits = pools
  }

  /**
   * Process incoming audio chunk: store in storage and queue for transcription
   */
  async processAudioChunk (audioData: Buffer, metadata: AudioChunkMetadata): Promise<void> {
    // Parse workspace and meeting ID from room name
    const parsed = parseRoomName(metadata.roomName)
    if (parsed === undefined) {
      this.ctx.error('Invalid room name format', { roomName: metadata.roomName })
      return
    }
    const { workspace, meetingId } = parsed

    // Transcript/payment limit: skip transcription without error
    if (this.limitsState?.isTranscriptBlocked(workspace) === true) {
      this.ctx.info('transcript limit exhausted, skipping transcription', { workspace })
      return
    }

    // Generate unique blob ID for this chunk
    const blobId = `audio-chunk-${uuid()}`

    // Get workspace client to access storage with proper wsIds
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) {
      this.ctx.error('Failed to get workspace client for audio chunk', { workspace })
      return
    }

    try {
      // Store audio in storage
      const contentType = metadata.audioFormat === 'ogg' ? 'audio/ogg' : 'audio/wav'
      await this.chunkStorageAdapter.put(this.ctx, wsClient.wsIds, blobId, audioData, contentType, audioData.length)

      // Create placeholder message for pending transcription (with spinner indicator)
      let placeholderMessageId: Ref<ChatMessage> | undefined
      if (meetingId !== undefined) {
        try {
          placeholderMessageId = await wsClient.createTranscriptionPlaceholder(
            this.ctx,
            metadata.participant as Ref<Person>,
            meetingId,
            metadata.startTimeSec,
            metadata.endTimeSec,
            blobId
          )
          this.ctx.info('Created transcription placeholder', {
            placeholderMessageId,
            participant: metadata.participant,
            startTimeSec: metadata.startTimeSec
          })
        } catch (err: any) {
          this.ctx.warn('Failed to create transcription placeholder', { error: err.message })
          // Continue without placeholder - transcription will still work
        }
      }

      // Create transcription task
      const task: TranscriptionTask = {
        blobId,
        roomName: metadata.roomName,
        participant: metadata.participant,
        startTimeSec: metadata.startTimeSec,
        endTimeSec: metadata.endTimeSec,
        durationSec: metadata.durationSec,
        hasSpeech: metadata.hasSpeech,
        speechRatio: metadata.speechRatio,
        peakAmplitude: metadata.peakAmplitude,
        rmsAmplitude: metadata.rmsAmplitude,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        bitsPerSample: metadata.bitsPerSample,
        audioFormat: metadata.audioFormat,
        placeholderMessageId: placeholderMessageId as string | undefined
      }

      // Queue for transcription with partition key based on workspace+participant
      // This ensures fair processing when multiple users are speaking simultaneously
      if (this.transcriptionProducer !== undefined) {
        const partitionKey = `${workspace}_${metadata.participant}`
        await this.transcriptionProducer.send(this.ctx, workspace, [task], partitionKey)
        this.ctx.info('Audio chunk queued for transcription', {
          blobId,
          workspace,
          participant: metadata.participant,
          durationSec: metadata.durationSec,
          hasSpeech: metadata.hasSpeech,
          placeholderMessageId
        })
      } else {
        this.ctx.warn('Transcription producer not set, audio chunk stored but not queued', { blobId })
      }
    } catch (err: any) {
      this.ctx.error('Failed to process audio chunk', { error: err.message, workspace })
    }
  }

  /**
   * Process full session recording: stream directly to storage and attach to meeting minutes
   */
  async processSessionRecording (stream: Readable, metadata: SessionRecordingMetadata): Promise<void> {
    // Parse workspace and meeting ID from room name
    const parsed = parseRoomName(metadata.roomName)
    if (parsed === undefined) {
      this.ctx.error('Invalid room name format for session', { roomName: metadata.roomName })
      return
    }
    const { workspace, meetingId: meetingMinutesId } = parsed

    // Get workspace client early (used to resolve MeetingMinutes -> Room if necessary)
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) {
      this.ctx.error('Failed to get workspace client for session recording', { workspace })
      return
    }

    try {
      // Generate unique blob ID for this session
      const blobId = `session-${metadata.participant}-${uuid()}.ogg`

      // Stream OGG Opus directly to storage
      await this.storageAdapter.put(this.ctx, wsClient.wsIds, blobId, stream, 'audio/ogg', metadata.size)

      this.ctx.info('Session recording stored', {
        blobId,
        workspace,
        participant: metadata.participant,
        startTimeSec: metadata.startTimeSec,
        endTimeSec: metadata.endTimeSec,
        size: metadata.size
      })

      // Add attachment to meeting minutes
      await wsClient.addSessionAttachment(
        meetingMinutesId,
        blobId,
        metadata.participantName,
        metadata.startTimeSec,
        metadata.endTimeSec,
        metadata.size,
        metadata.sessionNumber
      )
    } catch (err: any) {
      this.ctx.error('Failed to process session recording', { error: err.message, workspace })
    }
  }

  async createWorkspaceClient (workspace: WorkspaceUuid): Promise<WorkspaceClient | undefined> {
    const isAssigned = await tryAssignToWorkspace(workspace, this.ctx)

    if (!isAssigned) {
      this.ctx.error('Cannot assign to workspace', { workspace })
      return
    }

    const token = generateToken(this.personUuid, workspace, { service: 'aibot' })
    const accountClient = getAccountClient(token)
    const wsLoginInfo = await accountClient.getLoginInfoByToken()

    // Since AIBOT is internal service, always use internal transactor endpoint.
    const { endpoint, collaborator } = await getTransactorEndpointEx(token, 'internal')

    if (!isWorkspaceLoginInfo(wsLoginInfo)) {
      this.ctx.error('Invalid workspace login info', { workspace, wsLoginInfo })
      return
    }
    const wsIds: WorkspaceIds = {
      uuid: wsLoginInfo.workspace,
      url: wsLoginInfo.workspaceUrl,
      dataId: wsLoginInfo.workspaceDataId
    }

    this.ctx.info('Listen workspace: ', { workspace })

    return new WorkspaceClient(
      this.storageAdapter,
      endpoint,
      token,
      wsIds,
      this.personUuid,
      this.socialIds,
      this.ctx.newChild('create-workspace', {}, { span: false }),
      collaborator ?? wsLoginInfo.collaboratorEndpoint,
      this.llm
    )
  }

  async initWorkspaceClient (workspace: WorkspaceUuid): Promise<void> {
    if (this.connectingWorkspaces.has(workspace)) {
      return await this.connectingWorkspaces.get(workspace)
    }

    const initPromise = (async () => {
      try {
        if (!this.workspaces.has(workspace)) {
          const client = await this.createWorkspaceClient(workspace)
          if (client === undefined) {
            return
          }
          this.workspaces.set(workspace, client)
        }
      } catch (err: any) {
        this.ctx.error('Unknown error', { err })
      } finally {
        this.connectingWorkspaces.delete(workspace)
      }
    })()

    this.connectingWorkspaces.set(workspace, initPromise)

    await initPromise
  }

  async close (): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      await workspace.close()
    }
    this.workspaces.clear()

    await this.storageAdapter.close()
    await this.chunkStorageAdapter.close()
  }

  async getWorkspaceClient (workspace: WorkspaceUuid): Promise<WorkspaceClient | undefined> {
    await this.initWorkspaceClient(workspace)

    return this.workspaces.get(workspace)
  }

  // Token/payment limit: reject before any LLM call, 402 reaches the HTTP client
  checkTokensLimit (workspace: WorkspaceUuid): void {
    if (this.limitsState?.isTokensBlocked(workspace) === true) {
      this.ctx.warn('AI token limit exhausted, rejecting request', { workspace })
      throw new ApiError(402, 'AI token limit has been reached for this workspace. Please upgrade your plan.')
    }
  }

  // Language for the bot's non-personal output: AISpaceSettings for the space ->
  // workspace-wide default -> the pod's DefaultLanguage. The client's req.lang is
  // intentionally ignored (the space owns the language of non-personal replies).
  async resolveLanguage (workspace: WorkspaceUuid, space?: Ref<Space>): Promise<string> {
    try {
      const wsClient = await this.getWorkspaceClient(workspace)
      const client = wsClient?.client
      if (client === undefined) return config.DefaultLanguage

      const settings = await client.findAll(aiBot.class.AISpaceSettings, {})
      const forSpace = space !== undefined ? settings.find((s) => s.attachedTo === space) : undefined
      const wsDefault = settings.find((s) => s.attachedTo == null)
      return forSpace?.language ?? wsDefault?.language ?? config.DefaultLanguage
    } catch {
      return config.DefaultLanguage
    }
  }

  // Upsert the workspace-wide AISpaceSettings level (the one without attachedTo).
  async setWorkspaceLevel (workspace: WorkspaceUuid, level: AILevel): Promise<void> {
    const wsClient = await this.getWorkspaceClient(workspace)
    const client = wsClient?.client
    if (client === undefined) throw new Error('workspace client is not connected')

    const existing = (await client.findAll(aiBot.class.AISpaceSettings, {})).find((s) => s.attachedTo == null)
    if (existing !== undefined) {
      await client.updateDoc(aiBot.class.AISpaceSettings, existing.space, existing._id, { level })
      return
    }
    await client.createDoc(aiBot.class.AISpaceSettings, core.space.Workspace, { level })
  }

  async translate (workspace: WorkspaceUuid, req: TranslateRequest): Promise<TranslateResponse | undefined> {
    if (this.llm === undefined) {
      return undefined
    }
    this.checkTokensLimit(workspace)
    const lang = await this.resolveLanguage(workspace)
    const html = jsonToHTML(markupToJSON(req.text))
    const result = await this.llm.translateHtml(this.ctx, workspace, html, lang)
    const text = result !== undefined ? htmlToMarkup(result) : req.text
    return {
      text,
      lang
    }
  }

  async summarizeMessages (
    workspace: WorkspaceUuid,
    req: SummarizeMessagesRequest
  ): Promise<SummarizeMessagesResponse | undefined> {
    if (this.llm === undefined) return
    this.checkTokensLimit(workspace)
    if (req.target === undefined || req.targetClass === undefined) {
      return
    }

    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) {
      return
    }

    const client = wsClient.client

    const target = await client.findOne(req.targetClass, { _id: req.target })
    if (target === undefined) {
      this.ctx.error('target == null', { target: req.targetClass, _id: req.target })
      return
    }

    const messages = await client.findAll(
      chunter.class.ChatMessage,
      {
        attachedTo: target._id,
        collection: { $in: ['messages', 'transcription'] }
      },
      {
        sort: { createdOn: SortingOrder.Ascending },
        limit: 5000
      }
    )

    const personIds = new Set<PersonId>()
    for (const m of messages) {
      if (m.createdBy !== undefined) personIds.add(m.createdBy)
    }
    const identities = await client.findAll(contact.class.SocialIdentity, {
      _id: { $in: Array.from(personIds) as SocialIdentityRef[] }
    })
    const contacts = await client.findAll(contact.class.Contact, { _id: { $in: identities.map((i) => i.attachedTo) } })
    const contactById = toIdMap(contacts)
    const contactByPersonId = new Map<PersonId, Contact>()
    for (const identity of identities) {
      const contact = contactById.get(identity.attachedTo)
      if (contact !== undefined) contactByPersonId.set(identity._id, contact)
    }

    const messagesToSummarize: PersonMessage[] = []

    for (const m of messages) {
      const author = m.createdBy
      if (author === undefined) continue

      const contact = contactByPersonId.get(author)
      if (contact === undefined) continue

      const personName = contact.name
      const text = markupToMarkdown(markupToJSON(m.message))

      const lastPiece = messagesToSummarize[messagesToSummarize.length - 1]
      if (lastPiece?.personRef === contact._id) {
        lastPiece.text += (m.collection === 'transcription' ? ' ' : '\n') + text
      } else {
        messagesToSummarize.push({
          personRef: contact._id,
          personName,
          time: m.createdOn ?? 0,
          text
        })
      }
    }

    let description: string | undefined
    if (target._class === love.class.MeetingMinutes) {
      const meeting = target as MeetingMinutes
      if (wsClient.collaborator !== undefined && meeting.descriptionRef != null) {
        try {
          const descMarkup = await wsClient.collaborator.getMarkup(
            { objectClass: meeting._class, objectId: meeting._id, objectAttr: 'descriptionRef' },
            meeting.descriptionRef
          )
          const descMarkdown = markupToMarkdown(markupToJSON(descMarkup))
          if (descMarkdown.trim() !== '') {
            description = descMarkdown
          }
        } catch (err: any) {
          this.ctx.warn('Failed to load meeting description', {
            err: err?.message,
            meetingId: meeting._id,
            workspace
          })
        }
      }
    }
    const lang = await this.resolveLanguage(workspace, target.space)
    const summary = await this.llm.summarizeMessages(this.ctx, workspace, messagesToSummarize, lang, description)
    if (summary === undefined) return

    const summaryMarkup = jsonToMarkup(markdownToMarkup(summary))

    if (target._class === love.class.MeetingMinutes) {
      const meeting = target as MeetingMinutes
      if (wsClient.collaborator === undefined) {
        this.ctx.error('Collaborator client not available, cannot write meeting summary', { workspace })
        return
      }
      const collabDoc = { objectClass: meeting._class, objectId: meeting._id, objectAttr: 'summary' }
      try {
        // Prefer updateMarkup: doc may be live in hocuspocus (UI open) and createMarkup would throw "already exists".
        // On failure (no existing blob yet), fall back to createMarkup and persist blobRef on the meeting.
        await wsClient.collaborator.updateMarkup(collabDoc, summaryMarkup)
      } catch (err: any) {
        try {
          const blobRef = await wsClient.collaborator.createMarkup(collabDoc, summaryMarkup)
          await client.update(meeting, { summary: blobRef })
        } catch (createErr: any) {
          this.ctx.error('Failed to write meeting summary', {
            updateErr: err?.message,
            createErr: createErr?.message,
            meetingId: meeting._id,
            workspace
          })
        }
      }
    }

    return {
      text: summaryMarkup,
      lang
    }
  }

  /** Fix ASR errors in a voice-note transcript (level = space ceiling). Returns corrected text. */
  async correctTranscript (
    workspace: WorkspaceUuid,
    text: string,
    lang?: string,
    level?: AILevel
  ): Promise<string | undefined> {
    if (this.llm?.correctTranscript === undefined) return text
    this.checkTokensLimit(workspace)
    return await this.llm.correctTranscript(this.ctx, workspace, text, lang, level)
  }

  // Cheapest fallback-eligible (provider, level) whose pool is not exhausted; undefined if none.
  private resolvePoolFallback (
    fromProviderId: string,
    fromLevel: AILevel
  ): { providerId: string, level: AILevel } | undefined {
    const fbLevel = cheapestEligible(config.AIProviders)
    if (fbLevel === undefined || fbLevel === fromLevel) return undefined
    const resolved = resolveModel(fbLevel, config.AIProviders)
    if (this.poolLimits?.isBlockedByLevel(config.AIProviders, resolved.provider.id, resolved.level) === true) {
      return undefined
    }
    return { providerId: resolved.provider.id, level: resolved.level }
  }

  async processEvent (
    workspace: WorkspaceUuid,
    events: AIEventRequest[],
    control?: ConsumerControl,
    providerId?: string,
    level?: AILevel
  ): Promise<void> {
    // Resolve the per-provider instance (pipeline path) or fall back to the default.
    const provider = providerId !== undefined ? this.providers.get(providerId) : undefined
    if (provider === undefined && this.llm === undefined) {
      throw new Error('LLM provider not configured')
    }

    this.checkTokensLimit(workspace)

    // Global per-model pool guard. When this (provider, level) budget is exhausted, try
    // the cheapest fallback-eligible level (e.g. local `low`) instead of failing outright;
    // only reject if no fallback is available or it is exhausted too.
    let effProvider = provider
    let effProviderId = providerId
    let effLevel = level
    if (providerId !== undefined && level !== undefined && this.poolLimits !== undefined) {
      if (this.poolLimits.isBlockedByLevel(config.AIProviders, providerId, level)) {
        const fb = this.resolvePoolFallback(providerId, level)
        if (fb === undefined) {
          this.ctx.warn('AI provider pool exhausted, no fallback available', { workspace, providerId, level })
          throw new ApiError(
            402,
            'The global token budget for this model has been reached. Please contact your administrator.'
          )
        }
        this.ctx.info('AI pool exhausted, falling back to a simpler model', {
          workspace,
          from: { providerId, level },
          to: { providerId: fb.providerId, level: fb.level }
        })
        effProviderId = fb.providerId
        effLevel = fb.level
        effProvider = this.providers.get(fb.providerId) ?? provider
      }
    }

    const i1 = setInterval(() => {
      void control?.heartbeat()
    }, 1000)
    try {
      for (const event of events) {
        await control?.heartbeat()
        const wsClient = await this.getWorkspaceClient(workspace)
        if (wsClient === undefined) continue
        this.ctx.info('processing event', { ...event, providerId: effProviderId, level: effLevel })
        await wsClient.processMessageEvent(event, control, effProvider, effLevel, this.providers)
      }
    } finally {
      clearInterval(i1)
    }
  }

  async connect (workspace: WorkspaceUuid): Promise<void> {
    await this.initWorkspaceClient(workspace)
  }

  async loveConnect (workspace: WorkspaceUuid, request: ConnectMeetingRequest): Promise<void> {
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) return

    await wsClient.loveConnect(request)
  }

  async loveDisconnect (workspace: WorkspaceUuid, request: DisconnectMeetingRequest): Promise<void> {
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) return

    await wsClient.loveDisconnect(request)
  }

  async getLoveIdentity (roomName: string): Promise<IdentityResponse | undefined> {
    const parsed = parseRoomName(roomName)
    if (parsed === undefined) return

    const { workspace } = parsed
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) {
      this.ctx.error('Workspace not found', { workspace })
      return
    }

    return await wsClient.getLoveIdentity()
  }

  async processLoveTranscript (request: PostTranscriptRequest): Promise<void> {
    // Debug: incoming request details
    this.ctx.info('Processing love transcript request', {
      roomName: request.roomName,
      participant: request.participant
    })

    const parsed = parseRoomName(request.roomName)
    if (parsed === undefined) {
      this.ctx.warn('Invalid room name format in love transcript request', { roomName: request.roomName })
      return
    }
    const { workspace, meetingId: meetingMinutesId } = parsed

    // Get workspace client and resolve MeetingMinutes -> Room
    const wsClient = await this.getWorkspaceClient(workspace)
    if (wsClient === undefined) {
      this.ctx.error('Failed to get workspace client for love transcript', { workspace })
      return
    }

    const meetingMinutes = await wsClient.client.findOne(love.class.MeetingMinutes, { _id: meetingMinutesId })
    if (meetingMinutes?.roomId === undefined || meetingMinutes?.roomId === null) {
      this.ctx.error('MeetingMinutes not found or missing attached room for love transcript', { meetingMinutesId })
      return
    }

    const roomId = meetingMinutes.roomId

    this.ctx.info('Parsed roomName into workspace and roomId', { workspace, roomId })

    try {
      await wsClient.processLoveTranscript(this.ctx, request.transcript, request.participant, meetingMinutesId)
      this.ctx.info('Processed love transcript', {
        workspace,
        roomId,
        participant: request.participant,
        transcriptLength: request.transcript?.length ?? 0
      })
    } catch (err: any) {
      this.ctx.error('Error processing love transcript', {
        error: err?.message ?? String(err),
        workspace,
        roomId,
        participant: request.participant,
        roomName: request.roomName
      })
    }
  }
}
