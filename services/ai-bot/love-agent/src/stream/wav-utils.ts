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
 * WAV file utilities for audio recording
 * Provides functions for creating and updating WAV headers
 */

import { writeSync } from 'fs'
import { spawn } from 'child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import {
  createWavHeader as createWavHeaderDsp,
  parseWavHeader,
  extractWavSamples,
  normalizeAudio as normalizeAudioDsp,
  createWavFileFromFloat,
  WAV_HEADER_SIZE
} from '@hcengineering/audio-dsp'

/**
 * Creates a WAV file header for PCM audio data
 *
 * @param dataLength - Size of audio data in bytes
 * @param sampleRate - Sample rate in Hz (e.g., 16000)
 * @param channels - Number of channels (1 for mono, 2 for stereo)
 * @param bitsPerSample - Bits per sample (typically 16)
 * @returns Buffer containing 44-byte WAV header
 */
export function createWavHeader (
  dataLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): Buffer {
  // Use audio-dsp library for WAV header creation
  const headerArray = createWavHeaderDsp(dataLength, sampleRate, channels, bitsPerSample)
  return Buffer.from(headerArray)
}

/**
 * Updates WAV header with correct data length in-place in a file
 *
 * @param fd - File descriptor of the WAV file
 * @param dataLength - New data length in bytes
 */
export function updateWavHeader (fd: number, dataLength: number): void {
  const fileSizeBuffer = Buffer.alloc(4)
  const dataSizeBuffer = Buffer.alloc(4)

  // Update RIFF chunk size at offset 4
  fileSizeBuffer.writeUInt32LE(36 + dataLength, 0)
  writeSync(fd, fileSizeBuffer, 0, 4, 4)

  // Update data chunk size at offset 40
  dataSizeBuffer.writeUInt32LE(dataLength, 0)
  writeSync(fd, dataSizeBuffer, 0, 4, 40)
}

/**
 * Convert WAV file to OGG Opus using ffmpeg
 * OGG container with Opus codec is optimal for speech with excellent compression
 * and browser compatibility (pure .opus files don't play in most browsers)
 *
 * @param wavPath - Path to input WAV file
 * @param oggPath - Path for output OGG file
 * @returns Promise that resolves when conversion is complete
 */
export async function convertWavToOggOpus (wavPath: string, oggPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpegPath = ffmpegInstaller.path
    const args = [
      '-i',
      wavPath,
      '-codec:a',
      'libopus',
      '-b:a',
      '16k', // 16 kbps - optimal for 16kHz speech audio
      '-vbr',
      'on', // Variable bitrate for better quality
      '-compression_level',
      '1', // Fast compression (benchmarks show L1 is 3.3x faster with same or better compression ratio)
      '-application',
      'voip', // Optimized for speech
      '-y', // Overwrite output
      oggPath
    ]

    const proc = spawn(ffmpegPath, args)

    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`))
    })
  })
}

/**
 * Sanitize a string for use in file paths
 * Replaces spaces and special characters with underscores
 *
 * @param name - String to sanitize
 * @returns Sanitized string safe for file paths
 */
export function sanitizePath (name: string): string {
  return name.replace(/\s+/g, '_').replace(/[<>:"/\\|?*,]/g, '_')
}

/** Target RMS level for normalization */
const TARGET_RMS = 0.2

/** Target peak level for normalization (prevents clipping) */
const TARGET_PEAK = 0.95

/**
 * Normalizes audio samples to target RMS and peak levels while preserving dynamics.
 *
 * The function normalizes audio by:
 * 1. Computing RMS (Root Mean Square) and peak values
 * 2. Calculating scaling factors to reach target levels
 * 3. Applying the minimum of RMS and peak scaling to preserve dynamics
 *
 * This should be called before converting to Opus for consistent audio levels
 * across all participants and meetings.
 *
 * @param wavBuffer - Complete WAV file buffer (16-bit PCM with header)
 * @returns Normalized WAV buffer, or original if normalization not possible
 */
export function normalizeWavAudio (wavBuffer: Buffer): Buffer {
  const header = parseWavHeader(wavBuffer)

  if (header?.bitsPerSample !== 16) {
    // Return original if we can't parse or unsupported format
    return wavBuffer
  }

  if (wavBuffer.length <= WAV_HEADER_SIZE) {
    return wavBuffer
  }

  // Extract samples using audio-dsp library (returns Int16Array)
  const samples = extractWavSamples(wavBuffer)

  if (samples === undefined || samples.length === 0) {
    return wavBuffer
  }

  // Use audio-dsp library for normalization
  // normalizeAudioDsp handles Int16Array internally and returns Float32Array
  const normalizedSamples = normalizeAudioDsp(samples, {
    targetRms: TARGET_RMS,
    targetPeak: TARGET_PEAK
  })

  // Check if normalization made any significant change
  // If normalization didn't change much, return original to save processing
  let unchanged = true
  for (let i = 0; i < Math.min(100, samples.length); i++) {
    const originalNormalized = samples[i] / 32768.0
    if (Math.abs(normalizedSamples[i] - originalNormalized) > 0.01) {
      unchanged = false
      break
    }
  }

  if (unchanged) {
    return wavBuffer
  }

  // Reconstruct WAV file from normalized samples
  // createWavFileFromFloat expects Float32Array and returns Uint8Array
  const normalizedWav = createWavFileFromFloat(normalizedSamples, header.sampleRate, header.channels)

  return Buffer.from(normalizedWav)
}
