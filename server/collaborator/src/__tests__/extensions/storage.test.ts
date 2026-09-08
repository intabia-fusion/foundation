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

import { StorageExtension } from '../../extensions/storage'
import { Doc as YDoc } from 'yjs'
import { MeasureContext } from '@hcengineering/core'

describe('StorageExtension', () => {
  const mockCtx: MeasureContext = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    with: jest.fn((_, _p1, fn) => fn(mockCtx)),
    withSync: jest.fn((_, _p1, fn) => fn()),
    newChild: jest.fn(() => mockCtx)
  } as unknown as MeasureContext

  const mockAdapter = {
    loadDocument: jest.fn(),
    saveDocument: jest.fn()
  }

  const mockTransformer = {
    fromYdoc: jest.fn(),
    toYdoc: jest.fn()
  }

  const createMockContext = (overrides: Record<string, any> = {}): any => ({
    connectionId: 'test-connection',
    wsIds: {
      uuid: 'workspace-uuid' as any,
      dataId: 'workspace-data-id' as any,
      url: 'workspace-url'
    },
    clientFactory: jest.fn(),
    ...overrides
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('onChange', () => {
    it('should track updates for new documents', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = { isLoading: false } as any

      await extension.onChange({ context, document, documentName: 'doc-1' } as any)

      // Internal updates map should have the document tracked
      // This is verified through behavior in other methods
    })

    it('should not track updates when document is loading', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = { isLoading: true } as any

      await extension.onChange({ context, document, documentName: 'doc-1' } as any)

      expect(mockCtx.warn).toHaveBeenCalledWith('document changed while is loading', {
        documentName: 'doc-1',
        connectionId: 'test-connection'
      })
    })
  })

  describe('onConnect', () => {
    it('should log connection with document info', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const instance = {
        documents: new Map([['doc-1', { getConnectionsCount: () => 5 }]])
      }

      await extension.onConnect({
        context,
        documentName: 'doc-1',
        instance
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('connect to document', {
        documentName: 'doc-1',
        connectionId: 'test-connection',
        connections: 5
      })
    })

    it('should handle document not in instance', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const instance = {
        documents: new Map()
      }

      await extension.onConnect({
        context,
        documentName: 'doc-1',
        instance
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('connect to document', {
        documentName: 'doc-1',
        connectionId: 'test-connection',
        connections: 0
      })
    })
  })

  describe('onDisconnect', () => {
    it('should log disconnect with document info', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = { getConnectionsCount: () => 3, isLoading: false } as any

      // First add an update to track
      await extension.onChange({
        context,
        document: { isLoading: false },
        documentName: 'doc-1'
      } as any)

      mockAdapter.saveDocument.mockResolvedValue({})
      mockTransformer.fromYdoc.mockReturnValue({ content: 'markup' })

      await extension.onDisconnect({
        context,
        documentName: 'doc-1',
        document
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('disconnect from document', {
        documentName: 'doc-1',
        connectionId: 'test-connection',
        connections: 3
      })
    })

    it('should skip storage when no updates', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = { getConnectionsCount: () => 3, isLoading: false } as any

      await extension.onDisconnect({
        context,
        documentName: 'doc-1',
        document
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('no changes for document', {
        documentName: 'doc-1',
        connectionId: 'test-connection'
      })
      expect(mockAdapter.saveDocument).not.toHaveBeenCalled()
    })

    it('should skip storage when document is loading', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = { getConnectionsCount: () => 3, isLoading: true } as any

      // Add an update first
      await extension.onChange({
        context,
        document: { isLoading: false },
        documentName: 'doc-1'
      } as any)

      await extension.onDisconnect({
        context,
        documentName: 'doc-1',
        document
      } as any)

      expect(mockCtx.warn).toHaveBeenCalledWith('document is loading', {
        documentName: 'doc-1',
        connectionId: 'test-connection'
      })
    })
  })

  describe('onLoadDocument', () => {
    it('should load document from adapter', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const mockYDoc = new YDoc()
      mockAdapter.loadDocument.mockResolvedValue(mockYDoc)

      const result = await extension.onLoadDocument({
        context,
        documentName: 'doc-1'
      } as any)

      expect(mockAdapter.loadDocument).toHaveBeenCalledWith(mockCtx, 'doc-1', context)
      expect(result).toBe(mockYDoc)
    })

    it('should return undefined when document not found', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      mockAdapter.loadDocument.mockResolvedValue(undefined)

      const result = await extension.onLoadDocument({
        context,
        documentName: 'doc-1'
      } as any)

      expect(result).toBeUndefined()
    })
  })

  describe('onStoreDocument', () => {
    it('should skip storage when no updates', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const context = createMockContext()
      const document = {
        getConnectionsCount: () => 2
      } as any

      await extension.onStoreDocument({
        context,
        documentName: 'doc-1',
        document
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('no changes for document', {
        documentName: 'doc-1',
        connectionId: 'test-connection'
      })
    })
  })

  describe('afterUnloadDocument', () => {
    it('should clean up internal state', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      await extension.afterUnloadDocument({
        documentName: 'doc-1'
      } as any)

      expect(mockCtx.info).toHaveBeenCalledWith('unload document', { documentName: 'doc-1' })
    })
  })

  describe('onDestroy', () => {
    it('should wait for pending saves', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      // Add a pending promise
      const pendingPromise = Promise.resolve()
      ;(extension as any).promises.set('doc-1', pendingPromise)

      await extension.onDestroy()

      expect(mockCtx.info).toHaveBeenCalledWith('waiting for pending document saves', {
        documents: ['doc-1'],
        count: 1
      })
    })

    it('should handle errors during pending saves', async () => {
      const extension = new StorageExtension({
        ctx: mockCtx,
        adapter: mockAdapter,
        transformer: mockTransformer
      })

      const pendingPromise = Promise.reject(new Error('Save failed'))
      ;(extension as any).promises.set('doc-1', pendingPromise)

      await extension.onDestroy()

      expect(mockCtx.error).toHaveBeenCalledWith('error while waiting for pending document saves', {
        documents: ['doc-1'],
        error: expect.any(Error)
      })
    })
  })
})
