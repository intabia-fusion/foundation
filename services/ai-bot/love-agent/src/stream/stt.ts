//
// Copyright © 2025 Andrey Sobolev (haiodo@gmail.com)
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

/**
 * STT (Speech-to-Text) module for audio streaming and chunking
 * Handles audio capture from LiveKit, VAD-based chunking, and sending to platform
 */

import { AudioStream, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room } from '@livekit/rtc-node'
import { randomUUID } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'

import { Stt } from '../type.js'
import config from '../config.js'

// Import from extracted modules
import {
  type StreamTiming,
  type ChunkState,
  type SessionState,
  type ChunkMetadata,
  WRITE_BUFFER_SIZE,
  MAX_CHUNK_DURATION_MS,
  MIN_CHUNK_DURATION_MS,
  SPEECH_START_THRESHOLD_MS,
  LOOK_AHEAD_BUFFER_MS,
  PRE_BUFFER_MS
} from './types.js'

import { AudioAnalyzer, isFrameSpeech, getAdaptiveVADThreshold } from './audio-analysis.js'
import { AudioAnalyzerWasm } from './fft-wasm.js'

import { createAdaptiveVADState, updateNoiseFloor, updateSpeechRate, findOptimalCutPoint } from './chunk-detection.js'

import { createWavHeader, updateWavHeader, convertWavToOggOpus, sanitizePath, normalizeWavAudio } from './wav-utils.js'

/**
 * Get participant display name, handling empty string case
 * Falls back to identity if name is empty or undefined, then to sid
 */
function getParticipantDisplayName (participant: RemoteParticipant | undefined, sid: string): string {
  if (participant?.name !== undefined && participant.name.trim() !== '') {
    return participant.name
  }
  if (participant?.identity !== undefined && participant.identity.trim() !== '') {
    return participant.identity
  }
  return sid
}

export class STT implements Stt {
  private isInProgress = false
  private language: string = 'en'

  private readonly trackBySid = new Map<string, RemoteTrack>()
  private readonly streamBySid = new Map<string, AudioStream>()
  private readonly participantBySid = new Map<string, RemoteParticipant>()
  private readonly stoppedSids = new Set<string>()
  private readonly pendingFinalizations = new Map<string, Promise<void>>()
  private readonly pendingChunkFinalizations = new Map<string, Promise<void>[]>()

  private readonly sessionBySid = new Map<string, any>()
  private readonly timingBySid = new Map<string, StreamTiming>()
  private readonly chunkStateBySid = new Map<string, ChunkState>()
  private readonly sessionStateBySid = new Map<string, SessionState>()

  private transcriptionCount = 0
  private sessionNumber = 0
  private readonly meetingStartTime: number = Date.now()

  /** Set to divert finalized chunks away from the platform (offline tooling). */
  chunkSink?: (wav: Buffer, ogg: Buffer, metadata: ChunkMetadata) => Promise<void>

  private readonly rootDir: string
  private readonly meetingId: string = randomUUID()
  private readonly sampleRate = 16000
  private readonly channels = 1
  private readonly bitsPerSample = 16

  constructor (
    readonly room: Room,
    readonly workspace: string,
    readonly token: string
  ) {
    this.rootDir = join('dumps', sanitizePath(this.workspace), this.meetingId)
  }

  updateLanguage (language: string): void {
    this.language = language
  }

  start (): void {
    if (this.isInProgress) return
    this.isInProgress = true
    this.sessionNumber++

    console.info('Start transcription', {
      workspace: this.workspace,
      room: this.room.name,
      rootDir: this.rootDir,
      sessionNumber: this.sessionNumber,
      meetingStartTime: this.meetingStartTime,
      recordFullAudio: config.RecordFullAudio
    })
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true })
    }

    for (const sid of this.trackBySid.keys()) {
      this.processTrack(sid)
    }
  }

  stop (): void {
    if (!this.isInProgress) return
    console.info('Stopping transcription', { workspace: this.workspace, room: this.room.name })
    this.isInProgress = false
    for (const sid of this.trackBySid.keys()) {
      void this.stopWs(sid)
    }
  }

  subscribe (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    console.info('subscribe', {
      kind: track.kind,
      sid: publication.sid,
      name: participant.name,
      identity: participant.identity
    })
    const sid = publication.sid
    if (sid === undefined) return
    if (this.trackBySid.has(sid)) return
    this.trackBySid.set(sid, track)
    this.participantBySid.set(sid, participant)
    if (this.isInProgress) {
      this.processTrack(sid)
    }
  }

  async unsubscribe (
    track: RemoteTrack | undefined,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): Promise<void> {
    const sid = publication.sid
    if (sid === undefined) return

    console.info('unsubscribe', {
      kind: track?.kind ?? '',
      sid: publication.sid,
      name: participant.name,
      identity: participant.identity
    })
    // Stop the stream BEFORE deleting participant info from maps
    // This ensures finalizeSession can still access participant display name
    // Wait for stopWs to complete to ensure session is finalized before cleanup
    await this.stopWs(sid)
    this.trackBySid.delete(sid)
    this.participantBySid.delete(sid)
  }

  async stopWs (sid: string): Promise<void> {
    // If already finalizing, wait for the existing finalization to complete
    const existingPromise = this.pendingFinalizations.get(sid)
    if (existingPromise !== undefined) {
      // Just wait for the existing finalization to complete
      // Do not delete from map — the owner (original caller) handles cleanup
      await existingPromise
      return
    }

    const finalizationPromise = this.doStopWs(sid)
    this.pendingFinalizations.set(sid, finalizationPromise)

    try {
      await finalizationPromise
    } finally {
      this.pendingFinalizations.delete(sid)
      // Note: stoppedSids is NOT cleaned up here to avoid a race with streamToFiles().
      // streamToFiles() checks stoppedSids.has(sid) after the for-await loop to decide
      // whether to call finalizeChunk. If we cleared it here, streamToFiles() could see
      // a false negative and trigger duplicate finalization.
      // stoppedSids is cleaned up by streamToFiles() itself, or by close().
    }
  }

  private async doStopWs (sid: string): Promise<void> {
    try {
      this.stoppedSids.add(sid)

      const stream = this.streamBySid.get(sid)
      if (stream !== undefined) {
        ;(stream as any).close?.()
      }

      // Start final chunk finalization
      this.finalizeChunk(sid)

      // Wait for all pending chunk finalizations to complete
      const pendingChunks = this.pendingChunkFinalizations.get(sid) ?? []
      if (pendingChunks.length > 0) {
        try {
          await Promise.all(pendingChunks)
        } catch (err) {
          console.error('Error waiting for chunk finalizations', { sid, error: err })
        }
      }
      this.pendingChunkFinalizations.delete(sid)

      // Wait for session finalization to complete (including ffmpeg conversion and upload)
      try {
        await this.finalizeSession(sid)
      } catch (err) {
        console.error('Error finalizing session', { sid, error: err })
      }
    } catch (e) {
      console.error('Error in doStopWs', { sid, error: e })
    } finally {
      // Clean up resources except stoppedSids and pendingFinalizations:
      // - stoppedSids is owned by streamToFiles() which checks it after the for-await loop
      // - pendingFinalizations is owned by stopWs() which uses it to serialize concurrent calls
      this.streamBySid.delete(sid)
      this.sessionBySid.delete(sid)
      this.timingBySid.delete(sid)
      this.chunkStateBySid.delete(sid)
      this.sessionStateBySid.delete(sid)
    }
  }

  private flushWriteBuffer (chunkState: ChunkState): void {
    if (chunkState.fd !== null && chunkState.writeBufferOffset > 0) {
      writeSync(chunkState.fd, chunkState.writeBuffer, 0, chunkState.writeBufferOffset)
      chunkState.writeBufferOffset = 0
    }
  }

  private flushSessionWriteBuffer (sessionState: SessionState): void {
    if (sessionState.fd !== null && sessionState.writeBufferOffset > 0) {
      writeSync(sessionState.fd, sessionState.writeBuffer, 0, sessionState.writeBufferOffset)
      sessionState.writeBufferOffset = 0
    }
  }

  private writeToChunk (chunkState: ChunkState, data: Buffer): void {
    let dataOffset = 0

    while (dataOffset < data.length) {
      const spaceInBuffer = WRITE_BUFFER_SIZE - chunkState.writeBufferOffset
      const bytesToCopy = Math.min(spaceInBuffer, data.length - dataOffset)

      data.copy(chunkState.writeBuffer, chunkState.writeBufferOffset, dataOffset, dataOffset + bytesToCopy)
      chunkState.writeBufferOffset += bytesToCopy
      dataOffset += bytesToCopy

      if (chunkState.writeBufferOffset >= WRITE_BUFFER_SIZE) {
        this.flushWriteBuffer(chunkState)
      }
    }

    chunkState.chunkDataLength += data.length
  }

  private writeToSession (sessionState: SessionState, data: Buffer): void {
    let dataOffset = 0

    while (dataOffset < data.length) {
      const spaceInBuffer = WRITE_BUFFER_SIZE - sessionState.writeBufferOffset
      const bytesToCopy = Math.min(spaceInBuffer, data.length - dataOffset)

      data.copy(sessionState.writeBuffer, sessionState.writeBufferOffset, dataOffset, dataOffset + bytesToCopy)
      sessionState.writeBufferOffset += bytesToCopy
      dataOffset += bytesToCopy

      if (sessionState.writeBufferOffset >= WRITE_BUFFER_SIZE) {
        this.flushSessionWriteBuffer(sessionState)
      }
    }

    sessionState.dataLength += data.length
  }

  private finalizeChunk (sid: string, endReason: 'silence' | 'max_duration' | 'stream_end' = 'stream_end'): void {
    const chunkState = this.chunkStateBySid.get(sid)
    const timing = this.timingBySid.get(sid)
    const participant = this.participantBySid.get(sid)

    if (chunkState?.fd !== null && chunkState?.fd !== undefined && timing !== undefined) {
      const chunkDurationMs = chunkState.chunkEndTime - chunkState.chunkStartTime
      if (chunkDurationMs < MIN_CHUNK_DURATION_MS && endReason !== 'stream_end') {
        console.info('Skipping too short chunk', { sid, durationMs: chunkDurationMs, endReason })
        return
      }

      try {
        this.flushWriteBuffer(chunkState)
        updateWavHeader(chunkState.fd, chunkState.chunkDataLength)
        closeSync(chunkState.fd)

        const startTimeSec = (chunkState.chunkStartTime - this.meetingStartTime) / 1000
        const endTimeSec = (chunkState.chunkEndTime - this.meetingStartTime) / 1000
        const durationSec = endTimeSec - startTimeSec

        const rmsAmplitude =
          chunkState.totalSamples > 0 ? Math.sqrt(chunkState.sumSquares / chunkState.totalSamples) : 0
        const speechRatio = chunkState.totalSamples > 0 ? chunkState.activeSamples / chunkState.totalSamples : 0

        const metadata: ChunkMetadata = {
          startTimeSec,
          endTimeSec,
          durationSec,
          participant: participant?.identity ?? sid,
          participantName: getParticipantDisplayName(participant, sid),
          sampleRate: this.sampleRate,
          channels: this.channels,
          bitsPerSample: this.bitsPerSample,
          endReason,
          speechRatio,
          peakAmplitude: chunkState.peakAmplitude,
          rmsAmplitude
        }

        const wavFilePath = chunkState.chunkFilePath
        const chunkIndex = chunkState.chunkIndex

        if (wavFilePath !== null) {
          // Start async conversion and upload, track the promise
          const finalizationPromise = this.convertAndSendChunk(wavFilePath, sid, metadata, chunkIndex, chunkDurationMs)

          // Track pending chunk finalizations
          let pending = this.pendingChunkFinalizations.get(sid)
          if (pending === undefined) {
            pending = []
            this.pendingChunkFinalizations.set(sid, pending)
          }
          pending.push(finalizationPromise)

          // Remove from pending when done (fire-and-forget cleanup)
          void finalizationPromise.finally(() => {
            const currentPending = this.pendingChunkFinalizations.get(sid)
            if (currentPending !== undefined) {
              const index = currentPending.indexOf(finalizationPromise)
              if (index > -1) {
                void currentPending.splice(index, 1)
              }
            }
          })
        }
      } catch (e) {
        console.error('Error finalizing chunk', { error: e, sid })
      }

      chunkState.fd = null
      chunkState.chunkFilePath = null
      chunkState.chunkDataLength = 0
      chunkState.totalSamples = 0
      chunkState.activeSamples = 0
      chunkState.peakAmplitude = 0
      chunkState.sumSquares = 0
      chunkState.writeBufferOffset = 0
      chunkState.isSpeaking = false
      chunkState.consecutiveSpeechMs = 0
      chunkState.consecutiveSilenceMs = 0
      chunkState.chunkIndex++
    }
  }

  private async convertAndSendChunk (
    wavFilePath: string,
    sid: string,
    metadata: ChunkMetadata,
    chunkIndex: number,
    chunkDurationMs: number
  ): Promise<void> {
    const oggFilePath = wavFilePath.replace('.wav', '.ogg')

    try {
      // Read and normalize WAV before conversion
      const rawWavData = readFileSync(wavFilePath)
      const normalizedWavData = normalizeWavAudio(rawWavData)

      // Write normalized WAV back if it changed
      if (normalizedWavData !== rawWavData) {
        const { writeFileSync } = await import('fs')
        writeFileSync(wavFilePath, normalizedWavData)
      }

      // Convert normalized WAV to OGG Opus
      await convertWavToOggOpus(wavFilePath, oggFilePath)

      const wavSize = normalizedWavData.length
      const oggData = readFileSync(oggFilePath)

      // Offline runs (rushx split-audio) take the chunk here instead of the platform.
      if (this.chunkSink !== undefined) {
        await this.chunkSink(normalizedWavData, oggData, metadata)
      } else {
        await this.sendChunkToPlatform(oggData, sid, metadata)
      }

      console.info('Finalized chunk (opus)', {
        sid,
        chunkIndex,
        filePath: wavFilePath,
        durationMs: chunkDurationMs,
        participant: metadata.participant,
        participantName: metadata.participantName,
        endReason: metadata.endReason,
        speechRatio: metadata.speechRatio.toFixed(2),
        rmsAmplitude: metadata.rmsAmplitude.toFixed(4),
        originalSize: wavSize,
        compressedSize: oggData.length,
        compressionRatio: ((1 - oggData.length / wavSize) * 100).toFixed(1) + '%'
      })

      // Cleanup files
      if (!config.Debug) {
        try {
          unlinkSync(wavFilePath)
        } catch {}
        try {
          unlinkSync(oggFilePath)
        } catch {}
      }
    } catch (e) {
      console.error('Error converting/sending chunk', { error: e, sid, chunkIndex })
      // Cleanup on error
      if (!config.Debug) {
        try {
          unlinkSync(wavFilePath)
        } catch {}
        try {
          unlinkSync(oggFilePath)
        } catch {}
      }
    }
  }

  private async finalizeSession (sid: string): Promise<void> {
    const sessionState = this.sessionStateBySid.get(sid)
    const participant = this.participantBySid.get(sid)
    const timing = this.timingBySid.get(sid)

    if (sessionState?.fd === null || sessionState?.fd === undefined) {
      return
    }

    try {
      this.flushSessionWriteBuffer(sessionState)
      updateWavHeader(sessionState.fd, sessionState.dataLength)
      closeSync(sessionState.fd)

      if (sessionState.filePath === null || sessionState.dataLength === 0) {
        console.info('No session data to finalize', { sid })
        return
      }

      const durationSec = timing !== undefined ? (Date.now() - timing.streamStartTime) / 1000 : 0
      const startTimeSec = sessionState.startTimeFromMeeting
      const endTimeSec = startTimeSec + durationSec
      const participantIdentity = participant?.identity ?? sid
      const participantName = sanitizePath(getParticipantDisplayName(participant, sid))

      console.info('Finalizing session recording', {
        sid,
        participant: participantIdentity,
        participantName,
        dataLength: sessionState.dataLength,
        startTimeSec: startTimeSec.toFixed(1),
        endTimeSec: endTimeSec.toFixed(1),
        durationSec: durationSec.toFixed(1)
      })

      const oggPath = sessionState.filePath.replace('.wav', '.ogg')

      try {
        await convertWavToOggOpus(sessionState.filePath, oggPath)
        console.info('Converted session to OGG Opus', { sid, oggPath })

        const oggData = readFileSync(oggPath)

        await this.sendSessionToPlatform(
          oggData,
          participantIdentity,
          participantName,
          startTimeSec,
          endTimeSec,
          this.sessionNumber
        )

        if (!config.Debug) {
          unlinkSync(sessionState.filePath)
          unlinkSync(oggPath)
        }

        console.info('Session recording sent to platform', {
          sid,
          participant: participantName,
          oggSize: oggData.length,
          durationSec: durationSec.toFixed(1)
        })
      } catch (e) {
        console.error('Error converting/sending session', { error: e, sid })
        if (!config.Debug) {
          try {
            unlinkSync(sessionState.filePath)
          } catch {}
        }
      }
    } catch (e) {
      console.error('Error finalizing session', { error: e, sid })
    }
  }

  private startNewChunk (sid: string, streamDir: string, startTimeAbs: number): void {
    const chunkState = this.chunkStateBySid.get(sid)
    if (chunkState === undefined) return

    const startTimeSec = (startTimeAbs - this.meetingStartTime) / 1000
    const filename = `chunk_${chunkState.chunkIndex}_${startTimeSec.toFixed(1)}.wav`
    const filePath = join(streamDir, filename)

    try {
      const fd = openSync(filePath, 'w')
      const placeholderHeader = createWavHeader(0, this.sampleRate, this.channels, this.bitsPerSample)
      writeSync(fd, placeholderHeader)

      chunkState.fd = fd
      chunkState.chunkStartTime = startTimeAbs
      chunkState.chunkEndTime = startTimeAbs
      chunkState.chunkDataLength = 0
      chunkState.chunkFilePath = filePath
      chunkState.totalSamples = 0
      chunkState.activeSamples = 0
      chunkState.peakAmplitude = 0
      chunkState.sumSquares = 0
      chunkState.writeBufferOffset = 0
      chunkState.speechStartTime = startTimeAbs
      chunkState.silenceStartTime = 0
      chunkState.consecutiveSpeechMs = 0
      chunkState.consecutiveSilenceMs = 0

      console.info('Started new chunk', {
        sid,
        chunkIndex: chunkState.chunkIndex,
        filePath,
        startTimeSec: startTimeSec.toFixed(1)
      })
    } catch (e) {
      console.error('Error starting new chunk', { error: e, filePath })
    }
  }

  private startSession (sid: string, streamDir: string): void {
    // Skip full session recording if disabled
    if (!config.RecordFullAudio) {
      return
    }

    const participant = this.participantBySid.get(sid)
    const participantName = sanitizePath(getParticipantDisplayName(participant, sid))
    const filename = `${participantName}_session_${this.sessionNumber}.wav`
    const filePath = join(streamDir, filename)

    const now = Date.now()
    const startTimeFromMeeting = (now - this.meetingStartTime) / 1000

    try {
      const fd = openSync(filePath, 'w')
      const placeholderHeader = createWavHeader(0, this.sampleRate, this.channels, this.bitsPerSample)
      writeSync(fd, placeholderHeader)

      const sessionState: SessionState = {
        fd,
        filePath,
        dataLength: 0,
        writeBuffer: Buffer.alloc(WRITE_BUFFER_SIZE),
        writeBufferOffset: 0,
        startTimeFromMeeting,
        frameCount: 0,
        lastFrameHash: 0
      }

      this.sessionStateBySid.set(sid, sessionState)

      console.info('Started session recording', {
        sid,
        filePath,
        participant: getParticipantDisplayName(participant, sid),
        startTimeFromMeeting: startTimeFromMeeting.toFixed(1)
      })
    } catch (e) {
      console.error('Error starting session', { error: e, filePath })
    }
  }

  processTrack (sid: string): void {
    const track = this.trackBySid.get(sid)
    if (track === undefined) return

    if (this.streamBySid.has(sid)) {
      console.info('Stream already active for track, skipping', { sid })
      return
    }

    this.stoppedSids.delete(sid)

    const stream = new AudioStream(track, 16000)
    const participant = this.participantBySid.get(sid)

    console.info('Starting transcription for track', {
      room: this.room.name,
      sid,
      participant: getParticipantDisplayName(participant, sid)
    })

    this.streamBySid.set(sid, stream)

    void this.streamToFiles(sid, stream).catch((err) => {
      console.error('Failed to stream', { participant: getParticipantDisplayName(participant, sid), error: err })
    })
  }

  async streamToFiles (sid: string, stream: AudioStream): Promise<void> {
    const participant = this.participantBySid.get(sid)
    const streamDir = join(this.rootDir, sanitizePath(getParticipantDisplayName(participant, sid)))
    if (!existsSync(streamDir)) {
      mkdirSync(streamDir, { recursive: true })
    }

    const streamStartTime = Date.now()
    const timing: StreamTiming = {
      streamStartTime,
      lastFrameEndTime: streamStartTime
    }
    this.timingBySid.set(sid, timing)

    const chunkState: ChunkState = {
      fd: null,
      chunkStartTime: streamStartTime,
      chunkEndTime: streamStartTime,
      chunkDataLength: 0,
      chunkFilePath: null,
      totalSamples: 0,
      activeSamples: 0,
      peakAmplitude: 0,
      sumSquares: 0,
      writeBuffer: Buffer.alloc(WRITE_BUFFER_SIZE),
      writeBufferOffset: 0,
      isSpeaking: false,
      speechStartTime: 0,
      silenceStartTime: 0,
      lastSpeechEndTime: 0,
      consecutiveSpeechMs: 0,
      consecutiveSilenceMs: 0,
      chunkIndex: 0,
      preBuffer: [],
      preBufferDurationMs: 0,
      adaptiveVAD: createAdaptiveVADState()
    }
    this.chunkStateBySid.set(sid, chunkState)

    // Prefer WASM analyzer (~2x faster). Fall back to JS if the .wasm
    // binary is not available (e.g. in an environment where it wasn't
    // bundled). LOVE_DISABLE_WASM_FFT=1 forces the JS path.
    let analyzer: AudioAnalyzer | AudioAnalyzerWasm
    if (process.env.LOVE_DISABLE_WASM_FFT === '1') {
      analyzer = new AudioAnalyzer(this.sampleRate)
    } else {
      try {
        analyzer = new AudioAnalyzerWasm(this.sampleRate)
      } catch (err) {
        console.warn('WASM FFT unavailable, falling back to JS analyzer', err)
        analyzer = new AudioAnalyzer(this.sampleRate)
      }
    }

    this.startSession(sid, streamDir)

    console.info('Stream started', {
      sid,
      streamStartTime,
      meetingStartTime: this.meetingStartTime,
      streamDir,
      writeBufferSize: WRITE_BUFFER_SIZE,
      maxChunkDurationMs: MAX_CHUNK_DURATION_MS
    })

    for await (const frame of stream) {
      if (this.stoppedSids.has(sid)) {
        console.info('Stream stopped, exiting loop', { sid })
        break
      }

      if (!this.isInProgress) continue

      const frameStartTime = timing.lastFrameEndTime
      const frameDurationMs = (frame.samplesPerChannel / this.sampleRate) * 1000
      const frameEndTime = frameStartTime + frameDurationMs
      timing.lastFrameEndTime = frameEndTime

      const buf = Buffer.from(new Uint8Array(frame.data.buffer))
      const vadThreshold = getAdaptiveVADThreshold(chunkState.adaptiveVAD)
      const analysis = analyzer.analyze(buf, chunkState.adaptiveVAD.previousFrameSpectrum, vadThreshold)
      const frameHasSpeech = isFrameSpeech(analysis, chunkState.adaptiveVAD)

      updateNoiseFloor(chunkState.adaptiveVAD, analysis.rms, !frameHasSpeech)
      updateSpeechRate(chunkState.adaptiveVAD, frameEndTime, frameHasSpeech, frameDurationMs)

      if (analysis.spectrum !== null) {
        chunkState.adaptiveVAD.previousFrameSpectrum = analysis.spectrum
      }

      let currentFrameWrittenFromPreBuffer = false

      if (chunkState.fd === null) {
        chunkState.preBuffer.push({
          buf: Buffer.from(buf),
          analysis,
          frameStartTime,
          frameEndTime,
          hasSpeech: frameHasSpeech
        })
        chunkState.preBufferDurationMs += frameDurationMs

        const maxPreBufferMs = PRE_BUFFER_MS
        while (chunkState.preBufferDurationMs > maxPreBufferMs && chunkState.preBuffer.length > 1) {
          const removed = chunkState.preBuffer.shift()
          if (removed !== undefined) {
            chunkState.preBufferDurationMs -= removed.frameEndTime - removed.frameStartTime
          }
        }
      }

      if (frameHasSpeech) {
        chunkState.consecutiveSpeechMs += frameDurationMs
        chunkState.consecutiveSilenceMs = 0
        chunkState.lastSpeechEndTime = frameEndTime

        if (!chunkState.isSpeaking && chunkState.consecutiveSpeechMs >= SPEECH_START_THRESHOLD_MS) {
          chunkState.isSpeaking = true
          chunkState.speechStartTime = frameStartTime - chunkState.consecutiveSpeechMs

          if (chunkState.fd === null) {
            // Write the whole pre-buffer, not just what falls after speechStartTime: the VAD
            // only fires once the phrase is already loud enough, so its idea of "start" is
            // late by ~580ms on average (p90 1.4s) and the first word lands before it.
            const chunkStart = chunkState.preBuffer[0]?.frameStartTime ?? chunkState.speechStartTime
            this.startNewChunk(sid, streamDir, chunkStart)

            for (const preFrame of chunkState.preBuffer) {
              try {
                this.writeToChunk(chunkState, preFrame.buf)
                chunkState.totalSamples += preFrame.analysis.totalSamples
                chunkState.activeSamples += preFrame.analysis.activeSamples
                chunkState.sumSquares += preFrame.analysis.sumSquares
                if (preFrame.analysis.peak > chunkState.peakAmplitude) {
                  chunkState.peakAmplitude = preFrame.analysis.peak
                }
                if (preFrame.frameStartTime === frameStartTime) {
                  currentFrameWrittenFromPreBuffer = true
                }
              } catch (e) {
                console.error('Error writing pre-buffered frame to chunk', { error: e, sid })
              }
            }
            chunkState.preBuffer = []
            chunkState.preBufferDurationMs = 0
            chunkState.chunkEndTime = frameEndTime
          }
        }
      } else {
        chunkState.consecutiveSilenceMs += frameDurationMs
        chunkState.consecutiveSpeechMs = 0

        if (
          chunkState.isSpeaking &&
          chunkState.consecutiveSilenceMs >= chunkState.adaptiveVAD.adaptiveSilenceThresholdMs
        ) {
          chunkState.isSpeaking = false

          if (chunkState.fd !== null) {
            chunkState.chunkEndTime = chunkState.lastSpeechEndTime
            this.finalizeChunk(sid, 'silence')

            console.info('Phrase ended (silence detected)', {
              sid,
              silenceDurationMs: chunkState.consecutiveSilenceMs,
              adaptiveThresholdMs: chunkState.adaptiveVAD.adaptiveSilenceThresholdMs,
              speechRate: chunkState.adaptiveVAD.currentSpeechRate.toFixed(2),
              noiseFloor: chunkState.adaptiveVAD.noiseFloor.toFixed(4),
              chunkIndex: chunkState.chunkIndex
            })
          }
        }
      }

      if (chunkState.fd !== null) {
        const currentDuration = frameEndTime - chunkState.chunkStartTime

        if (currentDuration >= MAX_CHUNK_DURATION_MS - LOOK_AHEAD_BUFFER_MS) {
          chunkState.adaptiveVAD.lookAheadBuffer.push({
            buf: Buffer.from(buf),
            analysis,
            frameStartTime,
            frameEndTime,
            hasSpeech: frameHasSpeech
          })
          chunkState.adaptiveVAD.lookAheadDurationMs += frameDurationMs
        }

        if (currentDuration >= MAX_CHUNK_DURATION_MS) {
          const optimalCutIndex = findOptimalCutPoint(chunkState.adaptiveVAD.lookAheadBuffer, 50)

          if (optimalCutIndex >= 0 && optimalCutIndex < chunkState.adaptiveVAD.lookAheadBuffer.length) {
            for (let i = 0; i < optimalCutIndex; i++) {
              const laFrame = chunkState.adaptiveVAD.lookAheadBuffer[i]
              this.writeToChunk(chunkState, laFrame.buf)
              chunkState.totalSamples += laFrame.analysis.totalSamples
              chunkState.activeSamples += laFrame.analysis.activeSamples
              chunkState.sumSquares += laFrame.analysis.sumSquares
              if (laFrame.analysis.peak > chunkState.peakAmplitude) {
                chunkState.peakAmplitude = laFrame.analysis.peak
              }
            }
            chunkState.chunkEndTime = chunkState.adaptiveVAD.lookAheadBuffer[optimalCutIndex].frameStartTime
            this.finalizeChunk(sid, 'max_duration')

            console.info('Chunk finalized at optimal cut point', {
              sid,
              durationMs: currentDuration,
              cutPointIndex: optimalCutIndex,
              chunkIndex: chunkState.chunkIndex
            })

            if (chunkState.isSpeaking) {
              const remainingFrames = chunkState.adaptiveVAD.lookAheadBuffer.slice(optimalCutIndex)
              this.startNewChunk(sid, streamDir, remainingFrames[0]?.frameStartTime ?? frameEndTime)

              for (const laFrame of remainingFrames) {
                this.writeToChunk(chunkState, laFrame.buf)
                chunkState.totalSamples += laFrame.analysis.totalSamples
                chunkState.activeSamples += laFrame.analysis.activeSamples
                chunkState.sumSquares += laFrame.analysis.sumSquares
                if (laFrame.analysis.peak > chunkState.peakAmplitude) {
                  chunkState.peakAmplitude = laFrame.analysis.peak
                }
              }
              chunkState.chunkEndTime = frameEndTime
            }
          } else {
            chunkState.chunkEndTime = frameEndTime
            this.finalizeChunk(sid, 'max_duration')

            console.info('Chunk finalized (max duration, no optimal cut)', {
              sid,
              durationMs: currentDuration,
              chunkIndex: chunkState.chunkIndex
            })

            if (chunkState.isSpeaking) {
              this.startNewChunk(sid, streamDir, frameEndTime)
            }
          }

          chunkState.adaptiveVAD.lookAheadBuffer = []
          chunkState.adaptiveVAD.lookAheadDurationMs = 0
        }
      }

      if (chunkState.fd !== null && !currentFrameWrittenFromPreBuffer) {
        try {
          this.writeToChunk(chunkState, buf)
          chunkState.chunkEndTime = frameEndTime
          chunkState.totalSamples += analysis.totalSamples
          chunkState.activeSamples += analysis.activeSamples
          chunkState.sumSquares += analysis.sumSquares
          if (analysis.peak > chunkState.peakAmplitude) {
            chunkState.peakAmplitude = analysis.peak
          }
        } catch (e) {
          console.error('Error writing audio data to chunk', { error: e, sid })
        }
      }

      const sessionState = this.sessionStateBySid.get(sid)
      if (sessionState?.fd !== null && sessionState !== undefined) {
        try {
          let frameHash = 0
          for (let i = 0; i < Math.min(buf.length, 100); i++) {
            frameHash = ((frameHash << 5) - frameHash + buf[i]) | 0
          }
          frameHash = (frameHash + buf.length) | 0

          if (sessionState.lastFrameHash === frameHash && sessionState.frameCount > 0) {
            sessionState.duplicateCount = (sessionState.duplicateCount ?? 0) + 1
            // Only log duplicates if audio has significant amplitude (not silence)
            // and throttle to every 1000 duplicates
            if (analysis.rms > 0.01 && sessionState.duplicateCount % 1000 === 1) {
              console.warn('Duplicate frames detected in session (non-silent)', {
                sid,
                duplicateCount: sessionState.duplicateCount,
                frameCount: sessionState.frameCount,
                rms: analysis.rms
              })
            }
          } else {
            sessionState.duplicateCount = 0
          }

          sessionState.lastFrameHash = frameHash
          sessionState.frameCount++

          if (sessionState.frameCount % 100 === 0) {
            console.info('Session write progress', {
              sid,
              frameCount: sessionState.frameCount,
              dataLength: sessionState.dataLength,
              bufLength: buf.length,
              frameStartTime,
              frameEndTime
            })
          }

          this.writeToSession(sessionState, buf)
        } catch (e) {
          console.error('Error writing to session', { error: e, sid })
        }
      }
    }

    const wasStopped = this.stoppedSids.has(sid)

    if (!wasStopped && chunkState.fd !== null) {
      this.finalizeChunk(sid, 'stream_end')
    }

    this.stoppedSids.delete(sid)
    this.streamBySid.delete(sid)

    const streamEndTime = Date.now()
    console.info('Stream ended', {
      sid,
      wasStopped,
      streamStartTime: timing.streamStartTime,
      streamEndTime,
      totalDurationMs: streamEndTime - timing.streamStartTime,
      totalChunks: chunkState.chunkIndex + 1
    })
  }

  async sendChunkToPlatform (opusData: Buffer, sid: string, metadata: ChunkMetadata): Promise<void> {
    try {
      const response = await fetch(`${config.PlatformUrl}/love/send_raw`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'audio/ogg',
          Authorization: 'Bearer ' + this.token,
          'X-Room-Name': encodeURIComponent(this.room.name ?? ''),
          'X-Participant': metadata.participant,
          'X-Participant-Name': encodeURIComponent(metadata.participantName),
          'X-Start-Time': metadata.startTimeSec.toString(),
          'X-End-Time': metadata.endTimeSec.toString(),
          'X-Duration': metadata.durationSec.toString(),
          'X-Sample-Rate': metadata.sampleRate.toString(),
          'X-Channels': metadata.channels.toString(),
          'X-Bits-Per-Sample': metadata.bitsPerSample.toString(),
          'X-End-Reason': metadata.endReason,
          'X-Audio-Format': 'ogg'
        },
        body: new Uint8Array(opusData)
      })

      if (!response.ok) {
        console.error('Failed to send chunk to platform', {
          status: response.status,
          statusText: response.statusText,
          sid
        })
      }
    } catch (e) {
      console.error('Error sending chunk to platform', { error: e, sid })
    }
  }

  async sendSessionToPlatform (
    opusData: Buffer,
    participant: string,
    participantName: string,
    startTimeSec: number,
    endTimeSec: number,
    sessionNumber: number
  ): Promise<void> {
    try {
      const response = await fetch(`${config.PlatformUrl}/love/send_session`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'audio/ogg',
          'Content-Length': opusData.length.toString(),
          Authorization: 'Bearer ' + this.token,
          'X-Room-Name': encodeURIComponent(this.room.name ?? ''),
          'X-Participant': participant,
          'X-Participant-Name': encodeURIComponent(participantName),
          'X-Start-Time': startTimeSec.toString(),
          'X-End-Time': endTimeSec.toString(),
          'X-Session-Number': sessionNumber.toString()
        },
        body: new Uint8Array(opusData)
      })

      if (!response.ok) {
        console.error('Failed to send session to platform', {
          status: response.status,
          statusText: response.statusText,
          participant
        })
      }
    } catch (e) {
      console.error('Error sending session to platform', { error: e, participant })
    }
  }

  async sendToPlatform (transcript: string, sid: string): Promise<void> {
    const request = {
      transcript,
      participant: this.participantBySid.get(sid)?.identity,
      roomName: this.room.name
    }

    this.transcriptionCount++

    if (this.transcriptionCount === 1 || this.transcriptionCount % 50 === 0) {
      console.log('Sending transcript', this.room.name, this.transcriptionCount)
    }

    try {
      const res = await fetch(`${config.PlatformUrl}/love/transcript`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.token
        },
        body: JSON.stringify(request)
      })

      if (!res.ok) {
        let bodyText = '<no-body>'
        try {
          const text = await res.text()
          bodyText = text.length > 1000 ? text.substring(0, 1000) + '... (truncated)' : text
        } catch (err: any) {
          bodyText = `<failed-to-read-body: ${err.message}>`
        }
        console.error('Failed to send transcript to platform', {
          status: res.status,
          statusText: res.statusText,
          room: this.room.name,
          participant: request.participant,
          body: bodyText
        })
      } else {
        if (this.transcriptionCount === 1) {
          console.info('Transcript sent successfully', { room: this.room.name, participant: request.participant })
        }
      }
    } catch (e) {
      console.error('Error sending to platform', {
        error: e,
        room: this.room.name,
        participant: this.participantBySid.get(sid)?.identity
      })
    }
  }

  async close (): Promise<void> {
    // Stop all active streams — close() is end of meeting, everything must shut down
    const stopPromises: Promise<void>[] = []
    for (const sid of this.trackBySid.keys()) {
      stopPromises.push(this.stopWs(sid))
    }
    await Promise.all(stopPromises)

    // Wait for any remaining pending chunk finalizations (conversion + upload)
    const allChunkPromises: Promise<void>[] = []
    for (const pending of this.pendingChunkFinalizations.values()) {
      allChunkPromises.push(...pending)
    }
    if (allChunkPromises.length > 0) {
      try {
        await Promise.all(allChunkPromises)
      } catch (err) {
        console.error('Error waiting for chunk finalizations during close', { error: err })
      }
    }

    this.trackBySid.clear()
    this.participantBySid.clear()
    this.chunkStateBySid.clear()
    this.sessionStateBySid.clear()
    this.streamBySid.clear()
    this.timingBySid.clear()
    this.sessionBySid.clear()
    this.stoppedSids.clear()
    this.pendingFinalizations.clear()
    this.pendingChunkFinalizations.clear()
  }
}
