// Copyright © 2025 Andrey Sobolev (haiodo@gmail.com)

import { MeasureContext } from '@hcengineering/core'

import {
  SttProviderType,
  TranscriptionConfig,
  TranscriptionProvider,
  TranscriptionQueueTask,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptionWord,
  TranscriptionSegment,
  VadResult
} from './types'

import { createDeepgramProvider } from './providers/deepgram'
import { createOpenAIWhisperProvider } from './providers/openai'

import { analyzeAudio, parseWavHeader, getAudioDuration } from './vad'
import { normalizeAudio, getAudioStats } from './normalize'
import { ClisrServer } from '@intabiafusion/clisr'
import { createServerProvider } from './providers/server'

// Re-export types
export type {
  SttProviderType,
  TranscriptionConfig,
  TranscriptionProvider,
  TranscriptionQueueTask,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptionWord,
  TranscriptionSegment,
  VadResult
}

// Re-export utilities
export { analyzeAudio, parseWavHeader, getAudioDuration }
export { normalizeAudio, getAudioStats }

// Re-export provider creators
export { createDeepgramProvider } from './providers/deepgram'
export { createOpenAIWhisperProvider } from './providers/openai'

// Re-export consumer
export {
  createTranscriptionConsumer,
  TranscriptionConsumer,
  type SendToDeadLetterCallback,
  type CreateMessageWithTimestampCallback,
  type RetryConfig
} from './consumer'

/**
 * Create a transcription provider based on configuration
 *
 * @param ctx - Measure context for logging
 * @param config - Transcription configuration
 * @returns Configured transcription provider or undefined if misconfigured
 */
export function createTranscriptionProvider (
  ctx: MeasureContext,
  config: TranscriptionConfig,
  server?: ClisrServer
): TranscriptionProvider {
  switch (config.provider) {
    case 'deepgram': {
      if (config.apiKey === undefined || config.apiKey === '') {
        ctx.error('Deepgram API key not configured')
        throw new Error('Deepgram API key is not configured')
      }
      return createDeepgramProvider(ctx, config.apiKey, config.model)
    }

    case 'openai': {
      if (config.apiKey === undefined || config.apiKey === '') {
        ctx.error('OpenAI API key not configured')
        throw new Error('OpenAI API key is not configured')
      }
      return createOpenAIWhisperProvider(ctx, config.apiKey, config.model ?? 'whisper-1', config.url)
    }
    case 'server': {
      if (server === undefined) {
        ctx.error('Clisr server instance is required for server transcription provider')
        throw new Error('Clisr server instance is not provided')
      }
      return createServerProvider(ctx, server)
    }

    default: {
      ctx.error('Unknown transcription provider', { provider: config.provider })
      throw new Error('No transcript provider configured')
    }
  }
}
