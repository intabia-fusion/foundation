// Copyright © 2025 Andrey Sobolev (haiodo@gmail.com)

import { MeasureContext } from '@hcengineering/core'
import {
  AUDIO_FORMAT_INFO,
  TranscriptionOptions,
  TranscriptionProvider,
  TranscriptionResult,
  AudioFormat
} from '../types'

/**
 * Deepgram pre-recorded API response structure
 */
interface DeepgramResponse {
  metadata?: {
    request_id: string
    transaction_key: string
    sha256: string
    created: string
    duration: number
    channels: number
    models: string[]
    model_info: Record<
    string,
    {
      name: string
      version: string
      arch: string
    }
    >
  }
  results?: {
    channels: Array<{
      alternatives: Array<{
        transcript: string
        confidence: number
        words?: Array<{
          word: string
          start: number
          end: number
          confidence: number
          punctuated_word?: string
        }>
        paragraphs?: {
          paragraphs: Array<{
            sentences: Array<{
              text: string
              start: number
              end: number
            }>
          }>
        }
      }>
      detected_language?: string
      language_confidence?: number
    }>
    utterances?: Array<{
      start: number
      end: number
      confidence: number
      channel: number
      transcript: string
      words: Array<{
        word: string
        start: number
        end: number
        confidence: number
        punctuated_word?: string
      }>
      id: string
    }>
  }
}

/**
 * Deepgram pre-recorded (batch) API provider
 *
 * Uses the Deepgram Listen API for pre-recorded audio
 * Endpoint: POST https://api.deepgram.com/v1/listen
 *
 * Features:
 * - Multiple models: nova-2, nova, enhanced, base
 * - Language detection and specification
 * - Word-level timestamps
 * - Punctuation and smart formatting
 */
export class DeepgramProvider implements TranscriptionProvider {
  readonly name = 'deepgram'

  private readonly apiUrl = 'https://api.deepgram.com/v1/listen'

  constructor (
    private readonly ctx: MeasureContext,
    private readonly apiKey: string,
    private readonly model: string = 'nova-2'
  ) {}

  /**
   * Get content type and encoding for audio format
   */
  private getFormatInfo (format: AudioFormat): { contentType: string, encoding?: string } {
    // encoding only for wav; compressed containers Deepgram reads from the header.
    if (format === 'wav') {
      return { contentType: 'audio/wav', encoding: 'linear16' }
    }
    return { contentType: (AUDIO_FORMAT_INFO[format] ?? AUDIO_FORMAT_INFO.ogg).contentType }
  }

  async transcribe (audioData: Buffer, options: TranscriptionOptions): Promise<TranscriptionResult> {
    const startTime = Date.now()

    try {
      // Build query parameters
      const params = new URLSearchParams({
        model: this.model,
        punctuate: 'true',
        utterances: 'true',
        smart_format: 'true'
      })

      // Add language if specified, otherwise enable language detection
      if (options?.language !== undefined && options.language !== '') {
        params.set('language', options.language)
      } else {
        params.set('detect_language', 'true')
      }

      const { contentType, encoding } = this.getFormatInfo(options.audioFormat)

      // Audio encoding parameters (only for WAV)
      if (encoding !== undefined) {
        params.set('encoding', encoding)
        if (options?.sampleRate !== undefined) {
          params.set('sample_rate', options.sampleRate.toString())
        }
        if (options?.channels !== undefined) {
          params.set('channels', options.channels.toString())
        }
      }

      const url = `${this.apiUrl}?${params.toString()}`

      this.ctx.info('Sending audio to Deepgram', {
        contentType,
        size: audioData.length,
        model: this.model
      })

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': contentType
        },
        body: new Uint8Array(audioData)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Deepgram request failed: ${response.status} ${response.statusText} - ${errorText}`)
      }

      const data = (await response.json()) as DeepgramResponse

      const result = this.parseResponse(data)

      const elapsed = Date.now() - startTime
      this.ctx.info('Deepgram transcription completed', {
        provider: this.name,
        model: this.model,
        language: result.language,
        textLength: result.text.length,
        wordCount: result.words?.length ?? 0,
        elapsedMs: elapsed
      })

      return result
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      this.ctx.error('Deepgram transcription failed', {
        provider: this.name,
        model: this.model,
        error: err.message,
        elapsedMs: elapsed
      })
      throw err
    }
  }

  /**
   * Parse Deepgram response to standard format
   */
  private parseResponse (data: DeepgramResponse): TranscriptionResult {
    const result: TranscriptionResult = {
      text: '',
      language: undefined,
      confidence: undefined,
      words: undefined,
      segments: undefined
    }

    if (data.results?.channels === undefined || data.results.channels.length === 0) {
      return result
    }

    const channel = data.results.channels[0]

    if (channel.alternatives === undefined || channel.alternatives.length === 0) {
      return result
    }

    const alternative = channel.alternatives[0]

    // Extract main transcript
    result.text = alternative.transcript?.trim() ?? ''
    result.confidence = alternative.confidence

    // Extract detected language
    if (channel.detected_language !== undefined) {
      result.language = channel.detected_language
    }

    // Extract words with timestamps
    if (alternative.words !== undefined && alternative.words.length > 0) {
      result.words = alternative.words.map((w) => ({
        word: w.punctuated_word ?? w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence
      }))
    }

    // Extract segments from utterances
    if (data.results.utterances !== undefined && data.results.utterances.length > 0) {
      result.segments = data.results.utterances.map((u) => ({
        start: u.start,
        end: u.end,
        text: u.transcript.trim()
      }))
    } else if (alternative.paragraphs?.paragraphs !== undefined) {
      // Fallback to paragraphs if no utterances
      const segments: TranscriptionResult['segments'] = []
      for (const para of alternative.paragraphs.paragraphs) {
        for (const sentence of para.sentences) {
          segments.push({
            start: sentence.start,
            end: sentence.end,
            text: sentence.text.trim()
          })
        }
      }
      if (segments.length > 0) {
        result.segments = segments
      }
    }

    return result
  }
}

/**
 * Create Deepgram provider instance
 */
export function createDeepgramProvider (ctx: MeasureContext, apiKey: string, model?: string): DeepgramProvider {
  return new DeepgramProvider(ctx, apiKey, model ?? 'nova-2')
}
