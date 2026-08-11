//
// Copyright © 2026 Intabia Fusion.
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
import { MeasureContext, Ref, WorkspaceUuid } from '@hcengineering/core'
import aiBot, { AudioTranscribe, ChatVoiceTranscriptionTask } from '@hcengineering/ai-bot'
import config from './config'
import { pushTranscriptDuration, pushTranscriptUsageRecord } from './billing'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createTranscriptionConsumer, SendToDeadLetterCallback, TranscriptionConsumer } from './transcription/consumer'
import { AIControl } from './controller'
import love, { parseRoomName } from '@hcengineering/love'
import { Person } from '@hcengineering/contact'
import { ChatMessage } from '@hcengineering/chunter'
import { PlatformQueueProducer } from '@hcengineering/server-core'
import { TranscriptionConfig, TranscriptionQueueTask } from './transcription/types'
import { ClisrServer } from '@intabiafusion/clisr'
import { createTranscriptionProvider } from './transcription'
import { resolveTranscriptionConfig } from './transcription/asrRegistry'

export interface TranscriptionSupport {
  consumer: TranscriptionConsumer
  processChatVoice: (ctx: MeasureContext, workspace: WorkspaceUuid, task: ChatVoiceTranscriptionTask) => Promise<void>
}

export async function createTranscriptionsSupport (
  ctx: MeasureContext,
  aiControl: AIControl,
  transcriptionDeadLetterProducer?: PlatformQueueProducer<{
    task: TranscriptionQueueTask
    error: string
    errorType: string
  }>,
  server?: ClisrServer
): Promise<TranscriptionSupport | undefined> {
  // Resolve provider/model from the ASR registry (yaml `asr:` block). Empty registry -> disabled.
  const transcriptionConfig: TranscriptionConfig = resolveTranscriptionConfig(
    config.AsrProviders,
    config.AsrDefaultLevel,
    { vadRmsThreshold: config.VadRmsThreshold, vadSpeechRatioThreshold: config.VadSpeechRatioThreshold }
  )

  ctx.info('Transcription config', {
    provider: transcriptionConfig.provider,
    url: transcriptionConfig.url,
    vadRmsThreshold: transcriptionConfig.vadRmsThreshold,
    vadSpeechRatioThreshold: transcriptionConfig.vadSpeechRatioThreshold
  })

  if (transcriptionConfig.provider === undefined || transcriptionConfig.provider === '') {
    ctx.info('Transcription provider not configured, disabled')
    return undefined
  }

  const provider = createTranscriptionProvider(ctx, transcriptionConfig, server)

  // Per-workspace ASR level enforcement: resolve the provider for the workspace's
  // AISpaceSettings.asrLevel, caching one provider instance per level.
  const providerByLevel = new Map<string, ReturnType<typeof createTranscriptionProvider>>()
  providerByLevel.set(config.AsrDefaultLevel, provider)
  const resolveProvider = async (
    rctx: MeasureContext,
    workspace: WorkspaceUuid
  ): Promise<{ provider: ReturnType<typeof createTranscriptionProvider>, level: string } | undefined> => {
    try {
      const wsClient = await aiControl.getWorkspaceClient(workspace)
      const settings = await wsClient?.client?.findOne(aiBot.class.AISpaceSettings, { attachedTo: { $exists: false } })
      const level = settings?.asrLevel
      if (level === undefined || level === '' || level === config.AsrDefaultLevel) return undefined
      let p = providerByLevel.get(level)
      if (p === undefined) {
        const cfg = resolveTranscriptionConfig(config.AsrProviders, level, {
          vadRmsThreshold: config.VadRmsThreshold,
          vadSpeechRatioThreshold: config.VadSpeechRatioThreshold
        })
        if (cfg.provider === undefined || cfg.provider === '') return undefined
        p = createTranscriptionProvider(rctx, cfg, server)
        providerByLevel.set(level, p)
      }
      return { provider: p, level }
    } catch (e) {
      rctx.error('Failed to resolve per-workspace ASR provider', { workspace, e })
      return undefined
    }
  }

  try {
    if (config.DebugDir !== '' && config.DebugDir != null) {
      // We need to store chunk and transcription to testing file.
      if (!existsSync(config.DebugDir)) {
        await mkdir(config.DebugDir, { recursive: true })
      }
    }
    const transcriptionHandler = createTranscriptionConsumer(
      ctx,
      transcriptionConfig,
      provider,
      aiControl.chunkStorageAdapter,
      // Callback to get workspace storage info
      async (workspace: WorkspaceUuid) => {
        const wsClient = await aiControl.getWorkspaceClient(workspace)
        if (wsClient === undefined) {
          return undefined
        }
        return { wsIds: wsClient.wsIds }
      },
      async (
        ctx,
        workspace: WorkspaceUuid,
        roomName: string,
        participant: string,
        transcript: string,
        _startTimeSec: number,
        _endTimeSec: number
      ) => {
        const wsClient = await aiControl.getWorkspaceClient(workspace)
        if (wsClient === undefined) {
          ctx.error('Failed to get workspace client for sending transcript', { workspace })
          return
        }

        // Parse room name to get meeting ID
        const parsed = parseRoomName(roomName)
        if (parsed === undefined) {
          ctx.error('Invalid room name format', { roomName })
          return
        }
        const { meetingId: meetingMinutesId } = parsed

        // participant identity from LiveKit is Ref<Person> as string
        await wsClient.processLoveTranscript(ctx, transcript, participant as Ref<Person>, meetingMinutesId)
      },
      // Callback to update/delete placeholder message
      async (ctx, workspace: WorkspaceUuid, roomName: string, messageId: string, text: string | null) => {
        const wsClient = await aiControl.getWorkspaceClient(workspace)
        if (wsClient === undefined) {
          ctx.error('Failed to get workspace client for updating message', { workspace })
          return false
        }
        return await wsClient.updateTranscriptionMessage(ctx, messageId as Ref<ChatMessage>, text)
      },
      // Callback to create message with timestamp (fallback when placeholder not found)
      async (
        ctx,
        workspace: WorkspaceUuid,
        roomIdentifier: string, // Must be MeetingMinutes ID
        participant: string,
        text: string,
        startTimeSec: number
      ) => {
        const wsClient = await aiControl.getWorkspaceClient(workspace)
        if (wsClient === undefined) {
          ctx.error('Failed to get workspace client for creating fallback message', { workspace })
          return false
        }

        // Parse room name to get meeting ID
        const parsed = parseRoomName(roomIdentifier)
        if (parsed === undefined) {
          ctx.error('Invalid room name format', { roomIdentifier })
          return false
        }
        const { meetingId: meetingMinutesId } = parsed

        const client = wsClient.client
        const meetingMinutes = await client.findOne(love.class.MeetingMinutes, { _id: meetingMinutesId })

        if (meetingMinutes === undefined) {
          ctx.error('Failed to get meeting minutes for fallback message', { workspace, roomIdentifier })
          return false
        }

        // Calculate absolute timestamp: meeting creation time + offset in seconds
        const timestamp = (meetingMinutes.createdOn ?? Date.now()) + startTimeSec * 1000

        // Use the Room ID from the MeetingMinutes document for the message creation
        return await wsClient.createTranscriptionMessageWithTimestamp(
          ctx,
          text,
          participant as Ref<Person>,
          meetingMinutesId,
          timestamp
        )
      },
      // Callback to send failed tasks to dead letter queue
      (async (ctx, workspace, task, error, errorType) => {
        await transcriptionDeadLetterProducer?.send(ctx, workspace, [{ task, error, errorType }])
      }) as SendToDeadLetterCallback,
      config.DebugDir,
      undefined,
      resolveProvider,
      config.AsrDefaultLevel
    )

    if (!transcriptionHandler.isReady()) {
      ctx.warn('Transcription consumer not ready - check provider configuration', {
        provider: transcriptionConfig.provider
      })
    }

    // Chat voice-note path: read the attachment blob from workspace storage, transcribe,
    // LLM-correct, and write the text back onto the AudioTranscribe doc.
    const processChatVoice = async (
      pctx: MeasureContext,
      workspace: WorkspaceUuid,
      task: ChatVoiceTranscriptionTask
    ): Promise<void> => {
      const wsClient = await aiControl.getWorkspaceClient(workspace)
      if (wsClient === undefined) return
      const client = wsClient.client
      const doc = await client.findOne(aiBot.class.AudioTranscribe, { _id: task.transcribeId as Ref<AudioTranscribe> })
      if (doc === undefined || doc.state !== 'pending') return

      try {
        const audio = await aiControl.storageAdapter.read(pctx, wsClient.wsIds, task.blobId)
        // ponytail: webm/opus is sent as 'ogg' (both opus); server ASR decodes via ffmpeg.
        // Add real webm handling to AudioFormat if a provider rejects the container.
        const audioFormat = task.audioFormat === 'wav' ? 'wav' : 'ogg'
        const resolved = await resolveProvider(pctx, workspace)
        const asrProvider = resolved?.provider ?? provider
        const asrLevel = resolved?.level ?? config.AsrDefaultLevel
        const result = await asrProvider.transcribe(Buffer.concat(audio), { audioFormat, language: task.language })

        if (task.durationSec > 0) {
          await pushTranscriptDuration(pctx, workspace, task.durationSec, task.blobId)
          await pushTranscriptUsageRecord(pctx, workspace, task.durationSec, result.clientId, asrLevel)
        }

        const raw = result.text?.trim() ?? ''
        if (raw === '') {
          await client.update(doc, { state: 'failed' })
          return
        }
        const corrected = (await aiControl.correctTranscript(workspace, raw, task.language, task.level)) ?? raw
        await client.update(doc, { text: corrected, state: 'done', lang: result.language })
      } catch (err: any) {
        pctx.error('chat-voice transcription failed', { error: err?.message, blobId: task.blobId })
        try {
          await client.update(doc, { state: 'failed' })
        } catch {}
      }
    }

    return { consumer: transcriptionHandler, processChatVoice }
  } catch (err: any) {
    ctx.info('Failed to create transcription consumer', { error: err.message })
  }
  return undefined
}
