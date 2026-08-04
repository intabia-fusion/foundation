// Copyright © 2025 Andrey Sobolev (haiodo@gmail.com)

/**
 * Audio format type
 */
export type AudioFormat = 'ogg' | 'wav'

/**
 * Transcription task from the queue (extended from base TranscriptionTask)
 */
export interface TranscriptionQueueTask {
  /** Storage object name for audio file */
  blobId: string
  /** Room name from LiveKit (format: workspaceUuid_meetingMinutesId) */
  roomName: string
  /** Participant identity (Ref<Person>) */
  participant: string
  /** Start time in seconds from meeting start */
  startTimeSec: number
  /** End time in seconds from meeting start */
  endTimeSec: number
  /** Duration in seconds */
  durationSec: number

  // VAD metrics (not trusted, will be re-verified)
  /** Whether chunk contains speech (from love-agent, not trusted) */
  hasSpeech: boolean
  /** Ratio of speech to total duration (0-1) */
  speechRatio: number
  /** Peak amplitude (0-1 normalized) */
  peakAmplitude: number
  /** RMS amplitude (0-1 normalized) */
  rmsAmplitude: number

  // Audio parameters
  /** Sample rate (e.g., 16000) */
  sampleRate: number
  /** Number of channels (1 for mono) */
  channels: number
  /** Bits per sample (16) */
  bitsPerSample: number
  /** Audio format (ogg for Opus, wav for PCM) */
  audioFormat: AudioFormat
  /** Placeholder message ID for pending transcription (created when chunk received) */
  placeholderMessageId?: string
}

/**
 * Word-level timestamp information
 */
export interface TranscriptionWord {
  /** The word text */
  word: string
  /** Start time in seconds from chunk start */
  start: number
  /** End time in seconds from chunk start */
  end: number
  /** Confidence score (0-1), if available */
  confidence?: number
}

/**
 * Segment-level information
 */
export interface TranscriptionSegment {
  /** Start time in seconds from chunk start */
  start: number
  /** End time in seconds from chunk start */
  end: number
  /** Segment text */
  text: string
}

/**
 * Result from transcription provider
 */
export interface TranscriptionResult {
  /** Full transcribed text */
  text: string
  /** Detected or specified language code */
  language?: string
  /** Overall confidence score (0-1) */
  confidence?: number
  /** Word-level timestamps (needed for overlap correction) */
  words?: TranscriptionWord[]
  /** Segment-level information */
  segments?: TranscriptionSegment[]
  /** clisr worker that served this transcription; empty for local providers. */
  clientId?: string
}

/**
 * Options for transcription
 */
export interface TranscriptionOptions {
  /** Language hint (ISO code like 'en', 'ru') */
  language?: string
  /** Audio sample rate */
  sampleRate?: number
  /** Number of audio channels */
  channels?: number
  /** Request word-level timestamps (needed for overlap handling) */
  wordTimestamps?: boolean
  /** Audio format (ogg for Opus, wav for PCM) */
  audioFormat: AudioFormat
}

/**
 * Transcription provider interface
 */
export interface TranscriptionProvider {
  /** Provider name for logging */
  readonly name: string

  /**
   * Transcribe audio data
   * @param audioData - WAV audio buffer
   * @param options - Transcription options
   * @returns Transcription result with text and optional timestamps
   */
  transcribe: (audioData: Buffer, options: TranscriptionOptions) => Promise<TranscriptionResult>
}

/**
 * Available STT provider types
 * - 'openai' - OpenAI Whisper API (also supports self-hosted OpenAI-compatible endpoints via url)
 * - 'deepgram' - Deepgram API
 * - 'server' - Will host a clisr server, and call using round-robin to do a transcription on it.
 */
// 'none' opts a worker out of ASR entirely (ignores any `asr:` registry block).
export type SttProviderType = 'openai' | 'deepgram' | 'server' | 'none' | ''

/**
 * VAD (Voice Activity Detection) analysis result
 */
export interface VadResult {
  /** Whether speech was detected */
  hasSpeech: boolean
  /** Ratio of active samples to total (0-1) */
  speechRatio: number
  /** RMS amplitude (0-1 normalized) */
  rmsAmplitude: number
  /** Peak amplitude (0-1 normalized) */
  peakAmplitude: number
}

/**
 * Configuration for transcription providers
 */
export interface TranscriptionConfig {
  /** Selected provider type */
  provider: SttProviderType

  /** API URL for the selected provider */
  url?: string

  /** API key for the selected provider (not needed for wsr) */
  apiKey?: string

  /** Model to use (provider-specific) */
  model?: string

  // VAD settings
  vadRmsThreshold?: number
  vadSpeechRatioThreshold?: number
}
