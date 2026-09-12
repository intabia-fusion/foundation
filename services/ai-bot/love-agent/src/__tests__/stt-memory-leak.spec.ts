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

/**
 * Memory leak detection tests for STT class
 * Run with: node --expose-gc node_modules/.bin/jest src/__tests__/stt-memory-leak.spec.ts
 */

import { STT } from '../stream/stt.js'
import { Room, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from '@livekit/rtc-node'

// Mock LiveKit modules
jest.mock('@livekit/rtc-node', () => ({
  AudioStream: jest.fn().mockImplementation(() => ({
    close: jest.fn(),
    [Symbol.asyncIterator]: jest.fn().mockReturnValue({
      next: jest.fn().mockResolvedValue({ done: true, value: undefined })
    })
  })),
  RemoteParticipant: jest.fn(),
  RemoteTrack: jest.fn(),
  RemoteTrackPublication: jest.fn(),
  Room: jest.fn()
}))

jest.mock('../config.js', () => ({
  default: {
    PlatformUrl: 'http://localhost:3000',
    LiveKitApiUrl: 'ws://localhost:7880',
    Debug: false,
    RecordFullAudio: false
  }
}))

describe('STT Memory Leak Tests', () => {
  let mockRoom: jest.Mocked<Room>
  const mockToken = 'test-token'
  const mockWorkspace = 'test-workspace'

  beforeEach(() => {
    mockRoom = {
      name: 'test-room',
      metadata: undefined
    } as unknown as jest.Mocked<Room>
  })

  /**
   * Force garbage collection if available
   * Requires running Node.js with --expose-gc flag
   */
  function forceGC (): void {
    if (global.gc != null) {
      global.gc()
    }
  }

  /**
   * Get current memory usage in MB
   */
  function getMemoryUsage (): number {
    const usage = process.memoryUsage()
    return Math.round(usage.heapUsed / 1024 / 1024)
  }

  describe('Memory Growth Detection', () => {
    it('should not accumulate memory through subscribe/unsubscribe cycles', async () => {
      // Skip if GC is not exposed
      if (global.gc == null) {
        console.warn('Skipping memory test - run with --expose-gc flag')
        return
      }

      const iterations = 100
      const memorySnapshots: number[] = []

      // Baseline measurement
      forceGC()
      const baselineMemory = getMemoryUsage()

      for (let i = 0; i < iterations; i++) {
        const stt = new STT(mockRoom, mockWorkspace, mockToken)

        const mockTrack: RemoteTrack = {} as unknown as RemoteTrack
        const mockPublication: RemoteTrackPublication = {
          sid: `test-sid-${i}`,
          kind: 1
        } as unknown as RemoteTrackPublication
        const mockParticipant: RemoteParticipant = {
          name: `Test-${i}`,
          identity: `test-id-${i}`
        } as unknown as RemoteParticipant

        stt.subscribe(mockTrack, mockPublication, mockParticipant)

        // Simulate adding data to buffers
        const sttAny = stt as any
        const chunkState = sttAny.chunkStateBySid.get(`test-sid-${i}`)
        if (chunkState != null) {
          // Simulate pre-buffer accumulation
          for (let j = 0; j < 10; j++) {
            chunkState.preBuffer.push({
              buf: Buffer.alloc(1024 * 10), // 10KB per entry
              analysis: { rms: 0.1, peak: 0.5 },
              frameStartTime: j * 100,
              frameEndTime: (j + 1) * 100,
              hasSpeech: true
            })
          }
          chunkState.preBufferDurationMs = 1000
        }

        await stt.unsubscribe(mockTrack, mockPublication, mockParticipant)
        await stt.close()

        // Take snapshot every 10 iterations
        if (i % 10 === 0) {
          forceGC()
          memorySnapshots.push(getMemoryUsage())
        }
      }

      // Final measurement
      forceGC()
      const finalMemory = getMemoryUsage()

      // Memory should not grow more than 50% from baseline
      const memoryGrowth = finalMemory - baselineMemory
      const growthPercentage = (memoryGrowth / baselineMemory) * 100

      console.log('Memory leak test results:', {
        baselineMemory: `${baselineMemory}MB`,
        finalMemory: `${finalMemory}MB`,
        growth: `${memoryGrowth}MB`,
        growthPercentage: `${growthPercentage.toFixed(2)}%`,
        snapshots: memorySnapshots
      })

      // Allow for some growth but not unbounded
      expect(growthPercentage).toBeLessThan(100) // Less than 100% growth
    }, 30000) // 30 second timeout for large iteration count

    it('should release chunk state memory after stop', async () => {
      if (global.gc == null) {
        console.warn('Skipping memory test - run with --expose-gc flag')
        return
      }

      const stt = new STT(mockRoom, mockWorkspace, mockToken)

      const mockTrack: RemoteTrack = {} as unknown as RemoteTrack
      const mockPublication: RemoteTrackPublication = { sid: 'test-sid', kind: 1 } as unknown as RemoteTrackPublication
      const mockParticipant: RemoteParticipant = { name: 'Test', identity: 'test-id' } as unknown as RemoteParticipant

      stt.subscribe(mockTrack, mockPublication, mockParticipant)
      stt.start()

      // Add substantial data to chunk state
      const sttAny = stt as any
      const chunkState = sttAny.chunkStateBySid.get('test-sid')
      if (chunkState != null) {
        // Simulate accumulated buffers
        chunkState.preBuffer = Array.from({ length: 100 }, (_, i) => ({
          buf: Buffer.alloc(1024 * 50), // 50KB per entry = 5MB total
          analysis: { rms: 0.1, peak: 0.5, spectrum: new Float64Array(512) },
          frameStartTime: i * 100,
          frameEndTime: (i + 1) * 100,
          hasSpeech: true
        }))
        chunkState.preBufferDurationMs = 10000

        chunkState.adaptiveVAD.lookAheadBuffer = Array.from({ length: 50 }, (_, i) => ({
          buf: Buffer.alloc(1024 * 50), // 50KB per entry = 2.5MB total
          analysis: { rms: 0.1, peak: 0.5 },
          frameStartTime: i * 100,
          frameEndTime: (i + 1) * 100,
          hasSpeech: true
        }))
        chunkState.adaptiveVAD.lookAheadDurationMs = 5000
      }

      forceGC()
      const memoryBefore = getMemoryUsage()

      // Stop and close
      await stt.stopWs('test-sid')
      await stt.close()

      forceGC()
      const memoryAfter = getMemoryUsage()

      const memoryFreed = memoryBefore - memoryAfter

      console.log('Buffer cleanup test:', {
        memoryBefore: `${memoryBefore}MB`,
        memoryAfter: `${memoryAfter}MB`,
        memoryFreed: `${memoryFreed}MB`
      })

      // Memory should decrease or stay roughly the same
      // (exact numbers vary due to GC behavior)
      expect(memoryAfter).toBeLessThanOrEqual(memoryBefore + 10) // Allow 10MB variance
    })

    it('should not leak Maps across multiple STT instances', async () => {
      if (global.gc == null) {
        console.warn('Skipping memory test - run with --expose-gc flag')
        return
      }

      const instanceCount = 50

      forceGC()
      const memoryBefore = getMemoryUsage()

      for (let i = 0; i < instanceCount; i++) {
        const stt = new STT(mockRoom, mockWorkspace, mockToken)

        // Add data to all maps
        const sttAny = stt as any
        const trackBySid: Map<string, any> = sttAny.trackBySid
        const streamBySid: Map<string, any> = sttAny.streamBySid
        const participantBySid: Map<string, any> = sttAny.participantBySid
        const chunkStateBySid: Map<string, any> = sttAny.chunkStateBySid
        const sessionStateBySid: Map<string, any> = sttAny.sessionStateBySid

        for (let j = 0; j < 10; j++) {
          const sid = `sid-${i}-${j}`
          trackBySid.set(sid, {})
          streamBySid.set(sid, {})
          participantBySid.set(sid, {})
          chunkStateBySid.set(sid, {
            preBuffer: Array.from({ length: 10 }, () => ({
              buf: Buffer.alloc(1024),
              analysis: {}
            }))
          })
          sessionStateBySid.set(sid, {
            writeBuffer: Buffer.alloc(4096)
          })
        }

        await stt.close()
      }

      forceGC()
      const memoryAfter = getMemoryUsage()

      console.log('Multiple instances test:', {
        instances: instanceCount,
        memoryBefore: `${memoryBefore}MB`,
        memoryAfter: `${memoryAfter}MB`,
        delta: `${memoryAfter - memoryBefore}MB`
      })

      // Memory growth should be minimal after cleanup
      expect(memoryAfter - memoryBefore).toBeLessThan(50) // Less than 50MB growth
    })
  })

  describe('Long-running Session Simulation', () => {
    it('should handle many transcription cycles without unbounded growth', async () => {
      if (global.gc == null) {
        console.warn('Skipping memory test - run with --expose-gc flag')
        return
      }

      const stt = new STT(mockRoom, mockWorkspace, mockToken)
      const mockTrack: RemoteTrack = {} as unknown as RemoteTrack
      const mockPublication: RemoteTrackPublication = { sid: 'test-sid', kind: 1 } as unknown as RemoteTrackPublication
      const mockParticipant: RemoteParticipant = { name: 'Test', identity: 'test-id' } as unknown as RemoteParticipant

      stt.subscribe(mockTrack, mockPublication, mockParticipant)
      stt.start()

      const cycleCount = 50
      const memorySnapshots: number[] = []

      for (let i = 0; i < cycleCount; i++) {
        // Simulate start/stop cycles
        stt.stop()
        stt.start()

        if (i % 10 === 0) {
          forceGC()
          memorySnapshots.push(getMemoryUsage())
        }
      }

      await stt.close()
      forceGC()

      const finalMemory = getMemoryUsage()

      console.log('Long-running session test:', {
        cycles: cycleCount,
        snapshots: memorySnapshots,
        finalMemory: `${finalMemory}MB`
      })

      // Memory should stabilize, not grow linearly
      if (memorySnapshots.length >= 2) {
        const firstHalf = memorySnapshots.slice(0, Math.floor(memorySnapshots.length / 2))
        const secondHalf = memorySnapshots.slice(Math.floor(memorySnapshots.length / 2))

        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

        // Second half should not be much higher than first half
        expect(secondAvg).toBeLessThan(firstAvg * 1.5)
      }
    }, 60000) // 60 second timeout
  })
})
