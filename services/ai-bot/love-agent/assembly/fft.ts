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
// AssemblyScript FFT + spectral-feature kernel for love-agent VAD.
//
// Compiles to WASM via `rushx build:wasm`.
// Exports everything the JS analyzer needs in a single call to minimize
// JS<->WASM boundary overhead. All memory layout is fixed at init() time.

/*
  Memory layout (offsets are byte offsets into the single linear memory).
  init(fftSize) lays them out; they never move afterwards.

  base   size(bytes)  purpose
  ---- -----------   -------
  IN_OFF    N*4      f32 windowed input for the current frame
  REAL_OFF  N*8      f64 real[] (FFT workspace, also holds windowed input)
  IMAG_OFF  N*8      f64 imag[] (FFT workspace)
  MAG_OFF   N*8      f64 magnitude spectrum (output, for flux on JS side)
  HANN_OFF  N*4      f32 Hann window
  COS_OFF   (N/2)*8  f64 FFT cos table
  SIN_OFF   (N/2)*8  f64 FFT sin table
  REV_OFF   N*4      u32 bit-reversal table
  RES_OFF   8*8      f64 result[8] = [rms, peak, activeSamples, sumSquares,
                                      zeroCrossRate, lowBandE, highBandE, centroid]
*/

// Pointers are set during init. Start with 0 so accidental use before init
// fails fast (load at offset 0 returns 0).
let IN_OFF: usize = 0
let REAL_OFF: usize = 0
let IMAG_OFF: usize = 0
let MAG_OFF: usize = 0
let HANN_OFF: usize = 0
let COS_OFF: usize = 0
let SIN_OFF: usize = 0
let REV_OFF: usize = 0
let RES_OFF: usize = 0

// PCM input buffer — holds int16 samples from JS, separate from f32 input.
let PCM_OFF: usize = 0

let FFT_SIZE: i32 = 0

const VAD_FRAME_THRESHOLD: f32 = 0.01

// Band edges in Hz (must match src/stream/types.ts).
const SPEECH_BAND_LOW: f64 = 300
const SPEECH_BAND_HIGH: f64 = 3400
const HIGH_BAND_LOW: f64 = 3400
const HIGH_BAND_HIGH: f64 = 8000

/**
 * Allocate all workspaces for a fixed FFT size. Must be called once before
 * any call to analyzeFrame().
 *
 * Returns the byte offset of the PCM input buffer — the JS side writes
 * int16 PCM samples there before calling analyzeFrame.
 */
export function init (fftSize: i32, maxPcmSamples: i32): i32 {
  FFT_SIZE = fftSize

  // Grow memory enough for all buffers. Page = 64 KiB.
  const bytes =
    maxPcmSamples * 2 + // PCM int16 input
    fftSize * 4 + // f32 windowed input
    fftSize * 8 * 3 + // real/imag/mag f64
    fftSize * 4 + // hann f32
    (fftSize / 2) * 8 * 2 + // cos/sin f64
    fftSize * 4 + // reverse table u32
    8 * 8 // result

  const pages = ((bytes + 0xffff) & ~0xffff) >>> 16
  const currentPages = memory.size()
  if (<i32>currentPages < pages) {
    memory.grow(pages - <i32>currentPages)
  }

  // Lay out sequentially; reserve slot 0..16 as scratch sentinel.
  let off: usize = 16
  PCM_OFF = off
  off += <usize>(maxPcmSamples * 2)
  IN_OFF = off
  off += <usize>(fftSize * 4)
  REAL_OFF = off
  off += <usize>(fftSize * 8)
  IMAG_OFF = off
  off += <usize>(fftSize * 8)
  MAG_OFF = off
  off += <usize>(fftSize * 8)
  HANN_OFF = off
  off += <usize>(fftSize * 4)
  COS_OFF = off
  off += <usize>((fftSize / 2) * 8)
  SIN_OFF = off
  off += <usize>((fftSize / 2) * 8)
  REV_OFF = off
  off += <usize>(fftSize * 4)
  RES_OFF = off

  // Precompute Hann window.
  const denom = <f64>(fftSize - 1)
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * <f64>i) / denom)
    store<f32>(HANN_OFF + <usize>(i * 4), <f32>w)
  }

  // Precompute twiddle factors.
  const half = fftSize / 2
  for (let i = 0; i < half; i++) {
    const angle = (-2.0 * Math.PI * <f64>i) / <f64>fftSize
    store<f64>(COS_OFF + <usize>(i * 8), Math.cos(angle))
    store<f64>(SIN_OFF + <usize>(i * 8), Math.sin(angle))
  }

  // Precompute bit-reversal permutation.
  let bits = 0
  let x = fftSize
  while (x > 1) {
    x >>= 1
    bits++
  }
  for (let i = 0; i < fftSize; i++) {
    let reversed: u32 = 0
    let v = <u32>i
    for (let j = 0; j < bits; j++) {
      reversed = (reversed << 1) | (v & 1)
      v >>= 1
    }
    store<u32>(REV_OFF + <usize>(i * 4), reversed)
  }

  return <i32>PCM_OFF
}

// Exposed pointers so the JS wrapper can read the magnitude spectrum and
// result scalars without another call.
export function getPcmOffset (): i32 { return <i32>PCM_OFF }
export function getResultOffset (): i32 { return <i32>RES_OFF }
export function getMagnitudeOffset (): i32 { return <i32>MAG_OFF }

/**
 * Analyze one PCM frame.
 *
 * The JS side writes `pcmSamples` int16 samples into PCM_OFF.
 *
 * If runSpectral is 0 the FFT path is skipped — only RMS/peak/ZCR/active
 * are written. The magnitude buffer and spectral fields are left unchanged.
 *
 * Returns 1 if spectral path ran, 0 otherwise.
 */
export function analyzeFrame (pcmSamples: i32, sampleRate: i32, runSpectral: i32): i32 {
  // Single-pass over PCM: RMS / peak / active / ZCR + fill f32 normalized array.
  let activeSamples: i32 = 0
  let sumSquares: f64 = 0
  let peak: f32 = 0
  let zeroCrossings: i32 = 0
  let previous: f32 = 0

  const pcm = PCM_OFF
  const inF32 = IN_OFF

  for (let i = 0; i < pcmSamples; i++) {
    const s16 = load<i16>(pcm + <usize>(i * 2))
    const n: f32 = <f32>s16 / 32768.0
    store<f32>(inF32 + <usize>(i * 4), n)

    const abs: f32 = n >= 0 ? n : -n
    const nf64: f64 = n
    sumSquares += nf64 * nf64
    if (abs > peak) peak = abs
    if (abs > VAD_FRAME_THRESHOLD) activeSamples++

    if (i > 0 && ((previous >= 0 && n < 0) || (previous < 0 && n >= 0))) {
      zeroCrossings++
    }
    previous = n
  }

  const rms = Math.sqrt(sumSquares / <f64>pcmSamples)
  const zcr = <f64>zeroCrossings / <f64>pcmSamples

  // Store non-spectral results.
  store<f64>(RES_OFF + 0, rms)
  store<f64>(RES_OFF + 8, <f64>peak)
  store<f64>(RES_OFF + 16, <f64>activeSamples)
  store<f64>(RES_OFF + 24, sumSquares)
  store<f64>(RES_OFF + 32, zcr)

  if (runSpectral == 0) {
    return 0
  }

  // Apply Hann window into real[], zero imag[]. Pad with zeros if pcmSamples
  // is below FFT_SIZE (rare: 10 ms @ 16 kHz = 160, FFT_SIZE = 512 → padded).
  const real = REAL_OFF
  const imag = IMAG_OFF
  const hann = HANN_OFF
  const n = FFT_SIZE

  for (let i = 0; i < pcmSamples && i < n; i++) {
    const s = load<f32>(inF32 + <usize>(i * 4))
    const w = load<f32>(hann + <usize>(i * 4))
    store<f64>(real + <usize>(i * 8), <f64>(s * w))
    store<f64>(imag + <usize>(i * 8), 0)
  }
  for (let i = pcmSamples; i < n; i++) {
    store<f64>(real + <usize>(i * 8), 0)
    store<f64>(imag + <usize>(i * 8), 0)
  }

  // Bit-reversal permutation.
  for (let i = 0; i < n; i++) {
    const j = <i32>load<u32>(REV_OFF + <usize>(i * 4))
    if (j > i) {
      const tr = load<f64>(real + <usize>(i * 8))
      const tj = load<f64>(real + <usize>(j * 8))
      store<f64>(real + <usize>(i * 8), tj)
      store<f64>(real + <usize>(j * 8), tr)
      // imag is 0 here post-init, but generic swap for safety when called
      // repeatedly — imag[] wasn't zeroed after a previous run's butterflies.
      const ti = load<f64>(imag + <usize>(i * 8))
      const tji = load<f64>(imag + <usize>(j * 8))
      store<f64>(imag + <usize>(i * 8), tji)
      store<f64>(imag + <usize>(j * 8), ti)
    }
  }

  // Cooley-Tukey iterative FFT.
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1
    const tableStep = n / size
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const ti = j * tableStep
        const cos = load<f64>(COS_OFF + <usize>(ti * 8))
        const sin = load<f64>(SIN_OFF + <usize>(ti * 8))

        const evenIdx = i + j
        const oddIdx = i + j + halfSize

        const evenR = load<f64>(real + <usize>(evenIdx * 8))
        const evenI = load<f64>(imag + <usize>(evenIdx * 8))
        const oddR = load<f64>(real + <usize>(oddIdx * 8))
        const oddI = load<f64>(imag + <usize>(oddIdx * 8))

        const tReal = cos * oddR - sin * oddI
        const tImag = cos * oddI + sin * oddR

        store<f64>(real + <usize>(evenIdx * 8), evenR + tReal)
        store<f64>(imag + <usize>(evenIdx * 8), evenI + tImag)
        store<f64>(real + <usize>(oddIdx * 8), evenR - tReal)
        store<f64>(imag + <usize>(oddIdx * 8), evenI - tImag)
      }
    }
  }

  // Magnitude + band energies + centroid in one pass.
  const binWidth: f64 = <f64>sampleRate / <f64>n
  const speechLowBin = <i32>Math.floor(SPEECH_BAND_LOW / binWidth)
  const halfN = n / 2 - 1
  let speechHighBin = <i32>Math.ceil(SPEECH_BAND_HIGH / binWidth)
  if (speechHighBin > halfN) speechHighBin = halfN
  const highLowBin = <i32>Math.floor(HIGH_BAND_LOW / binWidth)
  let highHighBin = <i32>Math.ceil(HIGH_BAND_HIGH / binWidth)
  if (highHighBin > halfN) highHighBin = halfN

  let totalEnergy: f64 = 0
  let speechBandEnergy: f64 = 0
  let highBandEnergy: f64 = 0
  let weightedFreqSum: f64 = 0
  let totalMagnitude: f64 = 0

  for (let k = 0; k < n; k++) {
    const rr = load<f64>(real + <usize>(k * 8))
    const ii = load<f64>(imag + <usize>(k * 8))
    const magSq = rr * rr + ii * ii
    const mag = Math.sqrt(magSq)
    store<f64>(MAG_OFF + <usize>(k * 8), mag)

    totalEnergy += magSq
    totalMagnitude += mag
    weightedFreqSum += <f64>k * binWidth * mag

    if (k >= speechLowBin && k <= speechHighBin) speechBandEnergy += magSq
    if (k >= highLowBin && k <= highHighBin) highBandEnergy += magSq
  }

  const lowBandNorm = totalEnergy > 0 ? speechBandEnergy / totalEnergy : 0
  const highBandNorm = totalEnergy > 0 ? highBandEnergy / totalEnergy : 0
  const centroid = totalMagnitude > 0 ? weightedFreqSum / totalMagnitude : 0

  store<f64>(RES_OFF + 40, lowBandNorm)
  store<f64>(RES_OFF + 48, highBandNorm)
  store<f64>(RES_OFF + 56, centroid)

  return 1
}
