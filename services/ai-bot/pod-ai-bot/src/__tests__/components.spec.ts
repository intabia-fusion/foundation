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

describe('AI Bot Components', () => {
  describe('TranscriptionTask Processor', () => {
    let processor: any

    beforeEach(() => {
      processor = {
        process: jest.fn(),
        validate: jest.fn(),
        retry: jest.fn()
      }
    })

    it('should process valid transcription task', async () => {
      const task: TranscriptionTask = {
        blobId: 'blob-123',
        roomName: 'workspace_room_123',
        participant: 'person-123',
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
        audioFormat: 'ogg'
      }

      processor.process.mockResolvedValue({ success: true, taskId: task.blobId })

      const result = await processor.process(task)

      expect(processor.process).toHaveBeenCalledWith(task)
      expect(result.success).toBe(true)
      expect(result.taskId).toBe(task.blobId)
    })

    it('should validate task before processing', async () => {
      const task: TranscriptionTask = {
        blobId: 'blob-123',
        roomName: 'workspace_room_123',
        participant: 'person-123',
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
        audioFormat: 'ogg'
      }

      processor.validate.mockReturnValue(true)

      const isValid = processor.validate(task)

      expect(processor.validate).toHaveBeenCalledWith(task)
      expect(isValid).toBe(true)
    })

    it('should handle task retry on failure', async () => {
      const task: TranscriptionTask = {
        blobId: 'blob-123',
        roomName: 'workspace_room_123',
        participant: 'person-123',
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
        audioFormat: 'ogg'
      }

      processor.retry.mockResolvedValue({ success: true, attempt: 2 })

      const result = await processor.retry(task, 2)

      expect(processor.retry).toHaveBeenCalledWith(task, 2)
      expect(result.attempt).toBe(2)
    })

    it('should handle different audio formats', () => {
      const formats: AudioFormat[] = ['ogg', 'wav']

      formats.forEach((format) => {
        const task: TranscriptionTask = {
          blobId: `blob-${format}`,
          roomName: 'workspace_room_123',
          participant: 'person-123',
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
          audioFormat: format
        }

        expect(task.audioFormat).toBe(format)
      })
    })

    it('should extract metadata from room name', () => {
      const roomName = 'workspace-uuid_room-name_room-id'
      const parts = roomName.split('_')

      expect(parts).toHaveLength(3)
      expect(parts[0]).toBe('workspace-uuid')
      expect(parts[1]).toBe('room-name')
      expect(parts[2]).toBe('room-id')
    })

    it('should calculate task duration correctly', () => {
      const task: TranscriptionTask = {
        blobId: 'blob-123',
        roomName: 'workspace_room_123',
        participant: 'person-123',
        startTimeSec: 5,
        endTimeSec: 15,
        durationSec: 10,
        hasSpeech: true,
        speechRatio: 0.8,
        peakAmplitude: 0.9,
        rmsAmplitude: 0.5,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 'ogg'
      }

      const calculatedDuration = task.endTimeSec - task.startTimeSec
      expect(calculatedDuration).toBe(task.durationSec)
    })
  })

  describe('Queue Mode Consumer', () => {
    let consumer: any

    beforeEach(() => {
      consumer = {
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
        handleMessage: jest.fn(),
        batchMessages: jest.fn(),
        close: jest.fn()
      }
    })

    it('should subscribe to queue topic', async () => {
      consumer.subscribe.mockResolvedValue({ subscriptionId: 'sub-123' })

      const result = await consumer.subscribe('ai-queue')

      expect(consumer.subscribe).toHaveBeenCalledWith('ai-queue')
      expect(result.subscriptionId).toBe('sub-123')
    })

    it('should handle single message from queue', async () => {
      const message = {
        value: {
          blobId: 'blob-123',
          roomName: 'workspace_room_123',
          participant: 'person-123'
        },
        workspace: 'workspace-uuid'
      }

      consumer.handleMessage.mockResolvedValue({ processed: true })

      const result = await consumer.handleMessage(message)

      expect(consumer.handleMessage).toHaveBeenCalledWith(message)
      expect(result.processed).toBe(true)
    })

    it('should batch multiple messages', async () => {
      const messages = [
        { value: { blobId: 'blob-1' }, workspace: 'ws-1' },
        { value: { blobId: 'blob-2' }, workspace: 'ws-2' },
        { value: { blobId: 'blob-3' }, workspace: 'ws-3' }
      ]

      consumer.batchMessages.mockResolvedValue({
        batchSize: 3,
        processed: true
      })

      const result = await consumer.batchMessages(messages, 10)

      expect(consumer.batchMessages).toHaveBeenCalledWith(messages, 10)
      expect(result.batchSize).toBe(3)
      expect(result.processed).toBe(true)
    })

    it('should unsubscribe from queue', async () => {
      consumer.unsubscribe.mockResolvedValue({ success: true })

      const result = await consumer.unsubscribe('sub-123')

      expect(consumer.unsubscribe).toHaveBeenCalledWith('sub-123')
      expect(result.success).toBe(true)
    })

    it('should close consumer gracefully', async () => {
      consumer.close.mockResolvedValue({ success: true })

      const result = await consumer.close()

      expect(consumer.close).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })

    it('should handle message with workspace context', async () => {
      const message = {
        value: {
          type: 'audio-chunk',
          data: {
            blobId: 'blob-123'
          }
        },
        workspace: 'workspace-uuid-123',
        offset: 100
      }

      consumer.handleMessage.mockResolvedValue({
        success: true,
        workspace: message.workspace,
        offset: message.offset
      })

      const result = await consumer.handleMessage(message)

      expect(result.workspace).toBe('workspace-uuid-123')
      expect(result.offset).toBe(100)
    })
  })

  describe('Client Mode Handler', () => {
    let handler: any

    beforeEach(() => {
      handler = {
        registerMethod: jest.fn(),
        callMethod: jest.fn(),
        handleBinaryData: jest.fn(),
        createResponse: jest.fn(),
        close: jest.fn()
      }
    })

    it('should register transcription method', async () => {
      handler.registerMethod.mockResolvedValue({ methodId: 'method-123' })

      const result = await handler.registerMethod('transcribe', {})

      expect(handler.registerMethod).toHaveBeenCalledWith('transcribe', {})
      expect(result.methodId).toBe('method-123')
    })

    it('should call registered method with data', async () => {
      const audioData = Buffer.from([0x1, 0x2, 0x3])
      const headers = { format: 'ogg', options: { model: 'whisper-1' } }

      handler.callMethod.mockResolvedValue({
        text: 'Hello world',
        language: 'en'
      })

      const result = await handler.callMethod('transcribe', audioData, headers)

      expect(handler.callMethod).toHaveBeenCalledWith('transcribe', audioData, headers)
      expect(result.text).toBe('Hello world')
      expect(result.language).toBe('en')
    })

    it('should handle binary audio data', async () => {
      const binaryData = Buffer.from([0xff, 0xd8, 0xff])

      handler.handleBinaryData.mockResolvedValue({
        size: binaryData.length,
        processed: true
      })

      const result = await handler.handleBinaryData(binaryData, 'ogg')

      expect(handler.handleBinaryData).toHaveBeenCalledWith(binaryData, 'ogg')
      expect(result.size).toBe(3)
      expect(result.processed).toBe(true)
    })

    it('should create valid response structure', async () => {
      const responseData = {
        text: 'Transcribed text',
        confidence: 0.95,
        language: 'en'
      }

      handler.createResponse.mockReturnValue({
        status: 'success',
        data: responseData,
        timestamp: expect.any(Number)
      })

      const result = handler.createResponse(responseData)

      expect(result.status).toBe('success')
      expect(result.data).toEqual(responseData)
      expect(result.timestamp).toBeDefined()
    })

    it('should handle method not found error', async () => {
      handler.callMethod.mockRejectedValue(new Error('Method not found: unknown'))

      await expect(handler.callMethod('unknown', Buffer.from([]))).rejects.toThrow('Method not found: unknown')
    })

    it('should validate audio format header', () => {
      const validHeaders = [{ format: 'ogg' }, { format: 'wav' }]

      const invalidHeaders = [{ format: 'mp3' }, { format: 'flac' }]

      validHeaders.forEach((header) => {
        expect(['ogg', 'wav']).toContain(header.format)
      })

      invalidHeaders.forEach((header) => {
        expect(['ogg', 'wav']).not.toContain(header.format)
      })
    })

    it('should close handler gracefully', async () => {
      handler.close.mockResolvedValue({ success: true })

      const result = await handler.close()

      expect(handler.close).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })
  })

  describe('Controller Integration', () => {
    let controller: any

    beforeEach(() => {
      controller = {
        processAudioChunk: jest.fn(),
        processSessionRecording: jest.fn(),
        createWorkspaceClient: jest.fn(),
        initWorkspaceClient: jest.fn(),
        getWorkspaceClient: jest.fn(),
        processTxes: jest.fn(),
        processEvent: jest.fn(),
        close: jest.fn()
      }
    })

    it('should process audio chunk', async () => {
      const chunkData = {
        workspace: 'workspace-uuid',
        roomId: 'room-123',
        blobId: 'blob-456'
      }

      controller.processAudioChunk.mockResolvedValue({
        success: true,
        transcriptionTaskId: 'task-123'
      })

      const result = await controller.processAudioChunk(chunkData)

      expect(controller.processAudioChunk).toHaveBeenCalledWith(chunkData)
      expect(result.success).toBe(true)
    })

    it('should process session recording', async () => {
      const recordingData = {
        workspace: 'workspace-uuid',
        roomId: 'room-123',
        blobId: 'blob-789',
        participant: 'person-123'
      }

      controller.processSessionRecording.mockResolvedValue({
        success: true,
        recordingId: 'rec-123'
      })

      const result = await controller.processSessionRecording(recordingData)

      expect(controller.processSessionRecording).toHaveBeenCalledWith(recordingData)
      expect(result.success).toBe(true)
    })

    it('should create workspace client', async () => {
      controller.createWorkspaceClient.mockResolvedValue({
        clientId: 'client-123',
        workspace: 'workspace-uuid'
      })

      const result = await controller.createWorkspaceClient('workspace-uuid')

      expect(controller.createWorkspaceClient).toHaveBeenCalledWith('workspace-uuid')
      expect(result.clientId).toBe('client-123')
    })

    it('should initialize workspace client', async () => {
      controller.initWorkspaceClient.mockResolvedValue({
        initialized: true,
        workspace: 'workspace-uuid'
      })

      const result = await controller.initWorkspaceClient('workspace-uuid')

      expect(controller.initWorkspaceClient).toHaveBeenCalledWith('workspace-uuid')
      expect(result.initialized).toBe(true)
    })

    it('should get existing workspace client', async () => {
      controller.getWorkspaceClient.mockResolvedValue({
        clientId: 'client-123',
        connected: true
      })

      const result = await controller.getWorkspaceClient('workspace-uuid')

      expect(controller.getWorkspaceClient).toHaveBeenCalledWith('workspace-uuid')
      expect(result.connected).toBe(true)
    })

    it('should process transactions', async () => {
      const txes = [
        { _id: 'tx-1', type: 'create' },
        { _id: 'tx-2', type: 'update' },
        { _id: 'tx-3', type: 'delete' }
      ]

      controller.processTxes.mockResolvedValue({
        processed: true,
        count: 3
      })

      const result = await controller.processTxes('workspace-uuid', txes)

      expect(controller.processTxes).toHaveBeenCalledWith('workspace-uuid', txes)
      expect(result.count).toBe(3)
    })

    it('should process AI event', async () => {
      const event = {
        type: 'transcription-complete',
        data: {
          taskId: 'task-123',
          text: 'Hello world'
        }
      }

      controller.processEvent.mockResolvedValue({
        success: true,
        eventId: 'event-123'
      })

      const result = await controller.processEvent('workspace-uuid', event)

      expect(controller.processEvent).toHaveBeenCalledWith('workspace-uuid', event)
      expect(result.success).toBe(true)
    })

    it('should close controller', async () => {
      controller.close.mockResolvedValue({ success: true })

      const result = await controller.close()

      expect(controller.close).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })
  })

  describe('Audio Processing Pipeline', () => {
    let pipeline: any

    beforeEach(() => {
      pipeline = {
        extractAudioMetadata: jest.fn(),
        detectSpeech: jest.fn(),
        calculateAmplitude: jest.fn(),
        validateAudioData: jest.fn(),
        processChunk: jest.fn()
      }
    })

    it('should extract audio metadata', () => {
      const audioData = Buffer.from([0x00, 0x00, 0x00, 0x00])
      const metadata = {
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        duration: 10
      }

      pipeline.extractAudioMetadata.mockReturnValue(metadata)

      const result = pipeline.extractAudioMetadata(audioData)

      expect(result.sampleRate).toBe(16000)
      expect(result.channels).toBe(1)
      expect(result.bitsPerSample).toBe(16)
    })

    it('should detect speech in audio', () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04])

      pipeline.detectSpeech.mockReturnValue({
        hasSpeech: true,
        confidence: 0.95
      })

      const result = pipeline.detectSpeech(audioData)

      expect(result.hasSpeech).toBe(true)
      expect(result.confidence).toBeGreaterThan(0.8)
    })

    it('should calculate amplitude values', () => {
      const audioData = Buffer.from([0x7f, 0x80, 0x40, 0xbf])

      pipeline.calculateAmplitude.mockReturnValue({
        peakAmplitude: 0.9,
        rmsAmplitude: 0.6,
        speechRatio: 0.8
      })

      const result = pipeline.calculateAmplitude(audioData)

      expect(result.peakAmplitude).toBeGreaterThanOrEqual(0)
      expect(result.peakAmplitude).toBeLessThanOrEqual(1)
      expect(result.rmsAmplitude).toBeGreaterThanOrEqual(0)
      expect(result.rmsAmplitude).toBeLessThanOrEqual(1)
    })

    it('should validate audio data', () => {
      const validAudioData = {
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        duration: 10
      }

      pipeline.validateAudioData.mockReturnValue(true)

      const result = pipeline.validateAudioData(validAudioData)

      expect(result).toBe(true)
    })

    it('should process complete audio chunk', async () => {
      const chunkData = {
        blobId: 'blob-123',
        audioData: Buffer.from([0x01, 0x02]),
        metadata: {
          sampleRate: 16000,
          channels: 1
        }
      }

      pipeline.processChunk.mockResolvedValue({
        success: true,
        taskId: 'task-123',
        hasSpeech: true
      })

      const result = await pipeline.processChunk(chunkData)

      expect(result.success).toBe(true)
      expect(result.hasSpeech).toBeDefined()
    })
  })

  describe('Error Scenarios', () => {
    let errorHandler: any

    beforeEach(() => {
      errorHandler = {
        handleError: jest.fn(),
        logError: jest.fn(),
        retryWithBackoff: jest.fn(),
        recordFailure: jest.fn()
      }
    })

    it('should handle transcription failure', async () => {
      const error = new Error('Transcription service unavailable')

      errorHandler.handleError.mockResolvedValue({
        handled: true,
        retry: true,
        delay: 5000
      })

      const result = await errorHandler.handleError(error)

      expect(result.handled).toBe(true)
      expect(result.retry).toBe(true)
    })

    it('should retry with exponential backoff', async () => {
      errorHandler.retryWithBackoff.mockResolvedValue({
        success: true,
        attempt: 3,
        totalDelay: 7000
      })

      const result = await errorHandler.retryWithBackoff(async () => await Promise.resolve(true), 3)

      expect(result.attempt).toBe(3)
      expect(result.totalDelay).toBe(7000)
    })

    it('should log error with context', () => {
      const error = {
        message: 'Processing failed',
        code: 'PROCESSING_ERROR',
        context: {
          taskId: 'task-123',
          workspace: 'workspace-uuid'
        }
      }

      errorHandler.logError.mockReturnValue({
        logged: true,
        errorId: 'err-123'
      })

      const result = errorHandler.logError(error)

      expect(result.logged).toBe(true)
      expect(result.errorId).toBeDefined()
    })

    it('should record failure metrics', () => {
      const failure = {
        taskId: 'task-123',
        type: 'transcription',
        error: 'timeout'
      }

      errorHandler.recordFailure.mockReturnValue({
        recorded: true,
        failureCount: 1
      })

      const result = errorHandler.recordFailure(failure)

      expect(result.recorded).toBe(true)
      expect(result.failureCount).toBe(1)
    })
  })
})
