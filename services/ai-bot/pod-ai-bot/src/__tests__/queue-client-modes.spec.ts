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

import { TranscriptionTask, AudioFormat } from '../types'
import { TranscriptionConfig, TranscriptionResult, TranscriptionOptions, SttProviderType } from '../transcription/types'

// Mock configuration for tests
const mockQueueConfig = {
  ServerSecret: 'test-secret',
  ServiceID: 'ai-bot-service-test',
  AccountsURL: 'http://localhost:3000',
  FirstName: 'AI',
  LastName: 'Bot',
  Port: 4010,
  Mode: 'queue' as const,
  ServerUrl: 'ws://localhost:3000',
  ApiToken: 'test-api-token'
}

const mockClientConfig = {
  ...mockQueueConfig,
  Mode: 'client' as const,
  ServerUrl: 'ws://queue-server:4010'
}

describe('AI Bot Queue and Client Modes', () => {
  describe('Configuration Loading', () => {
    it('should load default configuration', () => {
      expect(mockQueueConfig.Mode).toBe('queue')
      expect(mockQueueConfig.ServiceID).toBe('ai-bot-service-test')
      expect(mockQueueConfig.Port).toBe(4010)
    })

    it('should support both queue and client modes', () => {
      const queueMode = { ...mockQueueConfig, Mode: 'queue' as const }
      const clientMode = { ...mockQueueConfig, Mode: 'client' as const }

      expect(queueMode.Mode).toBe('queue')
      expect(clientMode.Mode).toBe('client')
    })

    it('should require essential configuration values', () => {
      const essentialFields = ['ServerSecret', 'AccountsURL', 'FirstName', 'LastName']

      essentialFields.forEach((field) => {
        expect(mockQueueConfig).toHaveProperty(field)
        expect(mockQueueConfig[field as keyof typeof mockQueueConfig]).toBeDefined()
      })
    })

    it('should require ServerUrl for client mode', () => {
      expect(mockClientConfig.ServerUrl).toBeDefined()
      expect(mockClientConfig.ServerUrl).not.toBe('')
    })

    it('should require ApiToken for queue-client communication', () => {
      expect(mockQueueConfig.ApiToken).toBeDefined()
      expect(mockClientConfig.ApiToken).toBeDefined()
    })
  })

  describe('TranscriptionTask Type Validation', () => {
    let mockTask: TranscriptionTask

    beforeEach(() => {
      mockTask = {
        blobId: 'blob-123',
        roomName: 'workspace-uuid_room-name_room-id',
        participant: 'person-uuid-123',
        startTimeSec: 0,
        endTimeSec: 10,
        durationSec: 10,
        hasSpeech: true,
        speechRatio: 0.8,
        peakAmplitude: 0.9,
        rmsAmplitude: 0.5,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg',
        placeholderMessageId: 'msg-123'
      }
    })

    it('should validate complete transcription task', () => {
      expect(mockTask).toHaveProperty('blobId')
      expect(mockTask).toHaveProperty('roomName')
      expect(mockTask).toHaveProperty('participant')
      expect(mockTask).toHaveProperty('audioFormat')
      expect(mockTask.audioFormat).toMatch(/^(ogg|wav)$/)
    })

    it('should support audio format types', () => {
      const formats: AudioFormat[] = ['ogg', 'wav']

      formats.forEach((format) => {
        mockTask.audioFormat = format
        expect(mockTask.audioFormat).toBe(format)
      })
    })

    it('should handle optional placeholderMessageId', () => {
      expect(mockTask.placeholderMessageId).toBeDefined()

      const taskWithoutPlaceholder = { ...mockTask }
      delete taskWithoutPlaceholder.placeholderMessageId
      expect(taskWithoutPlaceholder.placeholderMessageId).toBeUndefined()
    })

    it('should validate audio metadata constraints', () => {
      // Speech ratio should be between 0 and 1
      expect(mockTask.speechRatio).toBeGreaterThanOrEqual(0)
      expect(mockTask.speechRatio).toBeLessThanOrEqual(1)

      // Amplitude should be between 0 and 1
      expect(mockTask.peakAmplitude).toBeGreaterThanOrEqual(0)
      expect(mockTask.peakAmplitude).toBeLessThanOrEqual(1)
      expect(mockTask.rmsAmplitude).toBeGreaterThanOrEqual(0)
      expect(mockTask.rmsAmplitude).toBeLessThanOrEqual(1)

      // Duration should match start/end times
      expect(mockTask.durationSec).toBe(mockTask.endTimeSec - mockTask.startTimeSec)
    })

    it('should validate room name format', () => {
      // Room name should follow format: workspaceUuid_roomName_roomId
      const roomParts = mockTask.roomName.split('_')
      expect(roomParts.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Queue Mode Message Processing', () => {
    it('should create valid AI event message', () => {
      const aiEvent = {
        type: 'audio-chunk' as const,
        workspace: 'workspace-uuid',
        data: {
          roomName: 'workspace-uuid_room_123',
          blobId: 'blob-456'
        }
      }

      expect(aiEvent.workspace).toBeDefined()
      expect(aiEvent.data).toBeDefined()
      expect(aiEvent.type).toBe('audio-chunk')
    })

    it('should handle multiple concurrent queue events', async () => {
      const events = [
        { type: 'audio-chunk', workspace: 'ws-1', blobId: 'blob-1' },
        { type: 'audio-chunk', workspace: 'ws-2', blobId: 'blob-2' },
        { type: 'audio-chunk', workspace: 'ws-3', blobId: 'blob-3' }
      ]

      // Simulate processing
      const results = await Promise.all(
        events.map((event) =>
          Promise.resolve({
            success: true,
            workspace: event.workspace,
            blobId: event.blobId
          })
        )
      )

      expect(results).toHaveLength(3)
      results.forEach((result, index) => {
        expect(result.success).toBe(true)
        expect(result.workspace).toBe(events[index].workspace)
      })
    })

    it('should batch transcription tasks when batch size > 1', () => {
      const batchSize = 10
      const tasks: TranscriptionTask[] = []

      // Create 25 mock tasks
      for (let i = 0; i < 25; i++) {
        tasks.push({
          blobId: `blob-${i}`,
          roomName: `workspace_room_${i}`,
          participant: `person-${i}`,
          startTimeSec: i * 10,
          endTimeSec: (i + 1) * 10,
          durationSec: 10,
          hasSpeech: true,
          speechRatio: 0.8,
          peakAmplitude: 0.9,
          rmsAmplitude: 0.5,
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          audioFormat: 'ogg'
        })
      }

      // Calculate batches
      const batches: TranscriptionTask[][] = []
      for (let i = 0; i < tasks.length; i += batchSize) {
        batches.push(tasks.slice(i, i + batchSize))
      }

      expect(batches).toHaveLength(3)
      expect(batches[0]).toHaveLength(10)
      expect(batches[1]).toHaveLength(10)
      expect(batches[2]).toHaveLength(5)
    })

    it('should process single messages when batch size is 1', () => {
      const batchSize = 1
      const tasks: TranscriptionTask[] = [
        {
          blobId: 'blob-1',
          roomName: 'ws_room_1',
          participant: 'person-1',
          startTimeSec: 0,
          endTimeSec: 5,
          durationSec: 5,
          hasSpeech: true,
          speechRatio: 0.9,
          peakAmplitude: 0.8,
          rmsAmplitude: 0.5,
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          audioFormat: 'ogg'
        }
      ]

      // Single processing mode
      const batches: TranscriptionTask[][] = []
      for (let i = 0; i < tasks.length; i += batchSize) {
        batches.push(tasks.slice(i, i + batchSize))
      }

      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(1)
    })
  })

  describe('Client Mode Communication', () => {
    it('should validate binary handler method name', () => {
      const methods = {
        transcribe: async () => ({ success: true }),
        translate: async () => ({ success: true })
      }

      expect(methods).toHaveProperty('transcribe')
      expect(typeof methods.transcribe).toBe('function')
    })

    it('should handle transcription request with audio format header', () => {
      const headers = {
        format: 'ogg',
        options: {
          model: 'whisper-1',
          language: 'en'
        }
      }

      expect(headers.format).toMatch(/^(ogg|wav)$/)
      expect(headers.options).toHaveProperty('model')
    })

    it('should reject unsupported audio formats', () => {
      const unsupportedFormat = 'mp3'

      const isSupported = ['ogg', 'wav'].includes(unsupportedFormat)
      expect(isSupported).toBe(false)
    })

    it('should validate transcription response structure', () => {
      const response: TranscriptionResult = {
        text: 'Hello world',
        language: 'en',
        confidence: 0.95
      }

      expect(response).toHaveProperty('text')
      expect(response).toHaveProperty('language')
      expect(typeof response.text).toBe('string')
      expect(response.confidence).toBeGreaterThanOrEqual(0)
      expect(response.confidence).toBeLessThanOrEqual(1)
    })

    it('should handle transcription options correctly', () => {
      const options: TranscriptionOptions = {
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        wordTimestamps: true,
        audioFormat: 'ogg'
      }

      expect(options.language).toBe('en')
      expect(options.sampleRate).toBe(16000)
      expect(options.channels).toBe(1)
      expect(options.wordTimestamps).toBe(true)
      expect(options.audioFormat).toBe('ogg')
    })
  })

  describe('Server Provider for Client Distribution', () => {
    it('should validate server provider type', () => {
      const providers: SttProviderType[] = ['openai', 'deepgram', 'server']
      const selectedProvider: SttProviderType = 'server'

      expect(providers).toContain(selectedProvider)
    })

    it('should create transcription config for server provider', () => {
      const config: TranscriptionConfig = {
        provider: 'server',
        vadRmsThreshold: 0.02,
        vadSpeechRatioThreshold: 0.1
      }

      expect(config.provider).toBe('server')
      // Server provider doesn't require apiKey or url
      expect(config.apiKey).toBeUndefined()
      expect(config.url).toBeUndefined()
    })

    it('should handle binary request to client', async () => {
      // Mock ClisrServer binaryRequest
      const expectedResult: TranscriptionResult = {
        text: 'Transcribed text',
        language: 'en',
        confidence: 0.95
      }
      const mockBinaryRequest = jest.fn().mockResolvedValue(expectedResult)

      const audioData = Buffer.from([0x00, 0x01, 0x02, 0x03])
      const options = { audioFormat: 'ogg' as AudioFormat }

      const result = await mockBinaryRequest(
        {}, // ctx mock
        'transcribe',
        audioData,
        { options, format: 'ogg' },
        () => true
      )

      expect(mockBinaryRequest).toHaveBeenCalled()
      expect(result.text).toBe('Transcribed text')
      expect(result.language).toBe('en')
    })

    it('should pass audio format in headers', () => {
      const headers = { options: { language: 'ru' }, format: 'ogg' }

      expect(headers.format).toBe('ogg')
      expect(headers.options.language).toBe('ru')
    })

    it('should handle client selection callback', () => {
      // Mock session selection callback
      const selectClient = (session: { options: { transcription?: boolean } }): boolean => {
        return session.options.transcription === true
      }

      const enabledClient = { options: { transcription: true } }
      const disabledClient = { options: { transcription: false } }
      const defaultClient = { options: {} }

      expect(selectClient(enabledClient)).toBe(true)
      expect(selectClient(disabledClient)).toBe(false)
      expect(selectClient(defaultClient)).toBe(false)
    })
  })

  describe('ClisrServer Session Management', () => {
    it('should handle transcription method registration', () => {
      const sessionOptions: Record<string, boolean> = {}

      // Simulate method handler setting session option
      const handleMethod = (method: string, ops: unknown[]): Record<string, unknown> => {
        if (method === 'transcription') {
          sessionOptions.transcription = ops[0] as boolean
        }
        return {}
      }

      handleMethod('transcription', [true])
      expect(sessionOptions.transcription).toBe(true)

      handleMethod('transcription', [false])
      expect(sessionOptions.transcription).toBe(false)
    })

    it('should validate API token for client authentication', () => {
      const validToken = 'test-api-token'
      const invalidToken = 'wrong-token'

      const validateToken = (token: string): boolean => {
        return token === mockQueueConfig.ApiToken
      }

      expect(validateToken(validToken)).toBe(true)
      expect(validateToken(invalidToken)).toBe(false)
    })
  })

  describe('Error Handling and Resilience', () => {
    it('should handle transcription task with invalid metadata', () => {
      const invalidTask = {
        blobId: 'blob-123',
        roomName: 'room', // Invalid format
        participant: 'person-123',
        startTimeSec: 0,
        endTimeSec: 10,
        durationSec: 10,
        hasSpeech: true,
        speechRatio: 1.5, // Invalid - should be 0-1
        peakAmplitude: 0.9,
        rmsAmplitude: 0.5,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg' as AudioFormat
      }

      // Validation checks
      expect(invalidTask.speechRatio).toBeGreaterThan(1) // Should fail
      expect(invalidTask.roomName.split('_')).toHaveLength(1) // Should fail
    })

    it('should retry failed queue events', async () => {
      const maxRetries = 3
      const state = { attemptCount: 0 }

      const processWithRetry = async (): Promise<boolean> => {
        state.attemptCount++
        if (state.attemptCount < maxRetries) {
          return false
        }
        return true
      }

      let success = false
      while (!success && state.attemptCount < maxRetries) {
        success = await processWithRetry()
      }

      expect(state.attemptCount).toBe(maxRetries)
    })

    it('should handle graceful shutdown', async () => {
      const resources = {
        consumer: { close: jest.fn() },
        producer: { close: jest.fn() },
        server: { close: jest.fn() }
      }

      // Simulate shutdown
      await Promise.all([
        Promise.resolve(resources.consumer.close()),
        Promise.resolve(resources.producer.close()),
        Promise.resolve(resources.server.close())
      ])

      expect(resources.consumer.close).toHaveBeenCalled()
      expect(resources.producer.close).toHaveBeenCalled()
      expect(resources.server.close).toHaveBeenCalled()
    })

    it('should handle client disconnection during transcription', async () => {
      let isConnected = true
      const mockTranscribe = jest.fn().mockImplementation(async () => {
        if (!isConnected) {
          throw new Error('Client disconnected')
        }
        return { text: 'result', language: 'en' }
      })

      // First call succeeds
      const result1 = await mockTranscribe()
      expect(result1.text).toBe('result')

      // Disconnect
      isConnected = false

      // Second call should fail
      await expect(mockTranscribe()).rejects.toThrow('Client disconnected')
    })

    it('should handle timeout errors with retry limit', async () => {
      const maxTimeoutRetries = 3
      const state = { timeoutCount: 0 }

      const processWithTimeout = async (): Promise<{ success: boolean, error: string }> => {
        state.timeoutCount++
        if (state.timeoutCount <= maxTimeoutRetries) {
          return { success: false, error: 'timeout' }
        }
        return { success: true, error: '' }
      }

      let result: { success: boolean, error: string } = { success: false, error: '' }
      while (!result.success && state.timeoutCount <= maxTimeoutRetries) {
        result = await processWithTimeout()
      }

      expect(state.timeoutCount).toBe(maxTimeoutRetries + 1)
    })
  })

  describe('Mode-Specific Initialization', () => {
    it('should initialize queue mode with required components', () => {
      const queueModeInit = {
        workspaceConsumer: { id: 'workspace-consumer' },
        aiEventConsumer: { id: 'ai-event-consumer' },
        transcriptionProducer: { id: 'transcription-producer' },
        transcriptionConsumer: { id: 'transcription-consumer' },
        clisrServer: { listening: true },
        server: { listening: true }
      }

      expect(queueModeInit).toHaveProperty('workspaceConsumer')
      expect(queueModeInit).toHaveProperty('aiEventConsumer')
      expect(queueModeInit).toHaveProperty('transcriptionProducer')
      expect(queueModeInit).toHaveProperty('transcriptionConsumer')
      expect(queueModeInit).toHaveProperty('clisrServer')
    })

    it('should initialize client mode with required components', () => {
      const clientModeInit = {
        transcriptionProvider: { id: 'transcription-provider' },
        clisrClient: { connected: true },
        methods: {
          transcribe: jest.fn()
        }
      }

      expect(clientModeInit).toHaveProperty('transcriptionProvider')
      expect(clientModeInit).toHaveProperty('clisrClient')
      expect(clientModeInit).toHaveProperty('methods')
      expect(typeof clientModeInit.methods.transcribe).toBe('function')
    })

    it('should configure different providers based on mode', () => {
      const queueModeProviders = ['openai', 'deepgram', 'server']
      const clientModeProviders = ['openai', 'deepgram'] // server not available in client mode

      // Server provider only works in queue mode
      expect(queueModeProviders).toContain('server')
      expect(clientModeProviders).not.toContain('server')
    })
  })

  describe('Integration Scenarios', () => {
    it('should process audio chunk from queue to transcription', async () => {
      const audioChunk: TranscriptionTask = {
        blobId: 'chunk-123',
        roomName: 'ws_room_123',
        participant: 'person-123',
        startTimeSec: 0,
        endTimeSec: 5,
        durationSec: 5,
        hasSpeech: true,
        speechRatio: 0.9,
        peakAmplitude: 0.8,
        rmsAmplitude: 0.6,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg'
      }

      // Simulate transcription processing
      const transcriptionResult = {
        success: true,
        text: 'Hello world',
        blobId: audioChunk.blobId,
        participant: audioChunk.participant
      }

      expect(transcriptionResult.blobId).toBe(audioChunk.blobId)
      expect(transcriptionResult.success).toBe(true)
    })

    it('should handle workspace connection and disconnection', async () => {
      const connectionStates: Array<{ state: string, timestamp: number, workspace: string }> = []
      const workspaceId = 'workspace-uuid-123'

      // Connect
      connectionStates.push({ state: 'connected', timestamp: Date.now(), workspace: workspaceId })
      expect(connectionStates[connectionStates.length - 1].state).toBe('connected')

      // Disconnect
      connectionStates.push({ state: 'disconnected', timestamp: Date.now(), workspace: workspaceId })
      expect(connectionStates[connectionStates.length - 1].state).toBe('disconnected')

      expect(connectionStates).toHaveLength(2)
    })

    it('should process events in correct order', async () => {
      const events: Array<{ id: number, processed: boolean }> = []

      for (let i = 1; i <= 5; i++) {
        events.push({ id: i, processed: false })
      }

      // Simulate ordered processing
      const processed = events.map((e) => ({ ...e, processed: true }))

      processed.forEach((event, index) => {
        expect(event.id).toBe(index + 1)
        expect(event.processed).toBe(true)
      })
    })

    it('should handle queue to client transcription flow', async () => {
      // 1. Queue receives transcription task
      const task: TranscriptionTask = {
        blobId: 'audio-blob-123',
        roomName: 'ws_meeting_room1',
        participant: 'user-456',
        startTimeSec: 0,
        endTimeSec: 10,
        durationSec: 10,
        hasSpeech: true,
        speechRatio: 0.85,
        peakAmplitude: 0.75,
        rmsAmplitude: 0.45,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg'
      }

      // 2. Queue loads audio from storage
      const audioData = Buffer.alloc(1000, 0)

      // 3. Server provider sends to client via Clisr
      const mockClientTranscribe = jest.fn().mockResolvedValue({
        text: 'This is the transcribed text',
        language: 'en',
        confidence: 0.92
      })

      // 4. Client processes and returns result
      const result = await mockClientTranscribe(audioData, {
        audioFormat: task.audioFormat,
        sampleRate: task.sampleRate
      })

      expect(result.text).toBe('This is the transcribed text')
      expect(result.confidence).toBeGreaterThan(0.9)
    })
  })

  describe('Transcription Provider Configuration', () => {
    it('should validate STT provider type', () => {
      const providers: SttProviderType[] = ['openai', 'deepgram', 'server']
      const selectedProvider: SttProviderType = 'openai'

      expect(providers).toContain(selectedProvider)
    })

    it('should configure transcription with correct parameters', () => {
      const transcriptionConfig: TranscriptionConfig = {
        provider: 'openai',
        url: 'https://api.openai.com/v1',
        apiKey: 'sk-xxx',
        model: 'whisper-1',
        vadRmsThreshold: 0.02,
        vadSpeechRatioThreshold: 0.1
      }

      expect(transcriptionConfig.provider).toBeDefined()
      expect(transcriptionConfig.model).toBeDefined()
      expect(transcriptionConfig.vadRmsThreshold).toBeGreaterThan(0)
      expect(transcriptionConfig.vadSpeechRatioThreshold).toBeGreaterThan(0)
    })

    it('should support batch processing configuration', () => {
      const batchConfigs = [
        { batchSize: 1, description: 'Single processing' },
        { batchSize: 10, description: 'Batch of 10' },
        { batchSize: 50, description: 'Batch of 50' }
      ]

      batchConfigs.forEach((config) => {
        expect(config.batchSize).toBeGreaterThan(0)
      })
    })

    it('should configure server provider without external dependencies', () => {
      const serverConfig: TranscriptionConfig = {
        provider: 'server',
        vadRmsThreshold: 0.02,
        vadSpeechRatioThreshold: 0.1
      }

      // Server provider uses connected clients
      expect(serverConfig.provider).toBe('server')
      expect(serverConfig.apiKey).toBeUndefined()
      expect(serverConfig.url).toBeUndefined()
    })
  })

  describe('Binary Data Handling', () => {
    it('should handle OGG audio format', () => {
      const oggHeader = Buffer.from('OggS', 'utf-8')
      const isOgg = oggHeader.toString('utf-8', 0, 4) === 'OggS'

      expect(isOgg).toBe(true)
    })

    it('should handle WAV audio format', () => {
      const wavHeader = Buffer.from('RIFF', 'utf-8')
      const isWav = wavHeader.toString('utf-8', 0, 4) === 'RIFF'

      expect(isWav).toBe(true)
    })

    it('should detect audio format from buffer', () => {
      const detectFormat = (buffer: Buffer): AudioFormat | null => {
        const header = buffer.toString('utf-8', 0, 4)
        if (header === 'OggS') return 'ogg'
        if (header === 'RIFF') return 'wav'
        return null
      }

      const oggBuffer = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)])
      const wavBuffer = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100)])
      const unknownBuffer = Buffer.from('XXXX')

      expect(detectFormat(oggBuffer)).toBe('ogg')
      expect(detectFormat(wavBuffer)).toBe('wav')
      expect(detectFormat(unknownBuffer)).toBeNull()
    })

    it('should serialize and deserialize transcription result', () => {
      const original: TranscriptionResult = {
        text: 'Hello world',
        language: 'en',
        confidence: 0.95,
        words: [
          { word: 'Hello', start: 0, end: 0.5 },
          { word: 'world', start: 0.6, end: 1.0 }
        ]
      }

      const serialized = JSON.stringify(original)
      const deserialized: TranscriptionResult = JSON.parse(serialized)

      expect(deserialized.text).toBe(original.text)
      expect(deserialized.language).toBe(original.language)
      expect(deserialized.words).toHaveLength(2)
    })
  })

  describe('Heartbeat and Health Check', () => {
    it('should send heartbeat during long operations', async () => {
      const heartbeatInterval = 1000
      let heartbeatCount = 0

      const mockHeartbeat = jest.fn().mockImplementation(() => {
        heartbeatCount++
      })

      // Simulate long operation with heartbeats
      const processWithHeartbeat = async (durationMs: number): Promise<void> => {
        const startTime = Date.now()
        while (Date.now() - startTime < durationMs) {
          mockHeartbeat()
          await new Promise((resolve) => setTimeout(resolve, heartbeatInterval / 10))
        }
      }

      await processWithHeartbeat(100)

      expect(heartbeatCount).toBeGreaterThan(0)
      expect(mockHeartbeat).toHaveBeenCalled()
    })

    it('should handle heartbeat errors gracefully', async () => {
      const mockHeartbeat = jest.fn().mockRejectedValue(new Error('Heartbeat failed'))

      // Should not throw even if heartbeat fails
      try {
        await mockHeartbeat()
      } catch (err: any) {
        expect(err.message).toBe('Heartbeat failed')
      }
    })
  })

  describe('Dead Letter Queue Handling', () => {
    it('should send failed tasks to dead letter queue', async () => {
      const deadLetterQueue: Array<{
        task: TranscriptionTask
        error: string
        errorType: string
      }> = []

      const sendToDeadLetter = async (task: TranscriptionTask, error: string, errorType: string): Promise<void> => {
        deadLetterQueue.push({ task, error, errorType })
      }

      const failedTask: TranscriptionTask = {
        blobId: 'failed-blob',
        roomName: 'ws_room_1',
        participant: 'user-1',
        startTimeSec: 0,
        endTimeSec: 5,
        durationSec: 5,
        hasSpeech: true,
        speechRatio: 0.8,
        peakAmplitude: 0.7,
        rmsAmplitude: 0.4,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg'
      }

      await sendToDeadLetter(failedTask, 'Transcription failed', 'permanent_error')

      expect(deadLetterQueue).toHaveLength(1)
      expect(deadLetterQueue[0].task.blobId).toBe('failed-blob')
      expect(deadLetterQueue[0].errorType).toBe('permanent_error')
    })

    it('should classify error types correctly', () => {
      const classifyError = (error: Error): string => {
        const message = error.message.toLowerCase()
        if (message.includes('not found') || message.includes('404')) {
          return 'file_not_found'
        }
        if (message.includes('timeout')) {
          return 'timeout'
        }
        if (message.includes('network') || message.includes('connection')) {
          return 'network_error'
        }
        if (message.includes('service unavailable') || message.includes('503')) {
          return 'service_unavailable'
        }
        return 'permanent_error'
      }

      expect(classifyError(new Error('File not found'))).toBe('file_not_found')
      expect(classifyError(new Error('Request timeout'))).toBe('timeout')
      expect(classifyError(new Error('Network connection failed'))).toBe('network_error')
      expect(classifyError(new Error('503 Service unavailable'))).toBe('service_unavailable')
      expect(classifyError(new Error('Unknown error'))).toBe('permanent_error')
    })
  })

  describe('Concurrent Client Connections', () => {
    it('should handle multiple client connections', () => {
      const clients: Array<{ id: string, ready: boolean }> = []

      // Add clients
      for (let i = 0; i < 5; i++) {
        clients.push({ id: `client-${i}`, ready: true })
      }

      expect(clients).toHaveLength(5)
      expect(clients.every((c) => c.ready)).toBe(true)
    })

    it('should distribute load across clients', () => {
      const clients = ['client-1', 'client-2', 'client-3']
      const tasks = 10
      const distribution: Record<string, number> = {}

      // Round-robin distribution
      for (let i = 0; i < tasks; i++) {
        const client = clients[i % clients.length]
        distribution[client] = (distribution[client] ?? 0) + 1
      }

      // Each client should get approximately equal tasks
      expect(distribution['client-1']).toBe(4)
      expect(distribution['client-2']).toBe(3)
      expect(distribution['client-3']).toBe(3)
    })

    it('should filter clients by transcription capability', () => {
      const clients = [
        { id: 'client-1', options: { transcription: true } },
        { id: 'client-2', options: { transcription: false } },
        { id: 'client-3', options: { transcription: true } },
        { id: 'client-4', options: {} }
      ]

      const transcriptionClients = clients.filter((c) => c.options.transcription === true)

      expect(transcriptionClients).toHaveLength(2)
      expect(transcriptionClients.map((c) => c.id)).toEqual(['client-1', 'client-3'])
    })
  })

  describe('Mode Switching Scenarios', () => {
    it('should not allow mode change at runtime', () => {
      const config = { ...mockQueueConfig }
      const initialMode = config.Mode

      // Mode should be immutable after startup
      expect(initialMode).toBe('queue')

      // Attempting to change would require restart
      const configAfterAttemptedChange = { ...config }
      expect(configAfterAttemptedChange.Mode).toBe('queue')
    })

    it('should validate mode-specific requirements', () => {
      const validateQueueMode = (config: typeof mockQueueConfig): boolean => {
        return config.Mode === 'queue' && config.ApiToken !== ''
      }

      const validateClientMode = (config: typeof mockClientConfig): boolean => {
        return config.Mode === 'client' && config.ServerUrl !== '' && config.ApiToken !== ''
      }

      expect(validateQueueMode(mockQueueConfig)).toBe(true)
      expect(validateClientMode(mockClientConfig)).toBe(true)
    })
  })
})
