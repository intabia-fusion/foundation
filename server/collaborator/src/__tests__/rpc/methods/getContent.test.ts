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

import { getContent } from '../../../rpc/methods/getContent'
import { MeasureContext } from '@hcengineering/core'

describe('getContent', () => {
  const mockCtx: MeasureContext = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    with: jest.fn((_, __, fn) => fn(mockCtx)),
    withSync: jest.fn((_, __, fn) => fn()),
    newChild: jest.fn(() => mockCtx)
  } as unknown as MeasureContext

  const mockContext = {
    connectionId: 'test-connection',
    wsIds: {
      uuid: 'workspace-uuid' as any,
      dataId: 'workspace-data-id' as any,
      url: 'workspace-url'
    },
    clientFactory: jest.fn()
  }

  const mockTransformer = {
    fromYdoc: jest.fn(),
    toYdoc: jest.fn()
  }

  const createMockConnection = (markupData: Record<string, string>): any => ({
    transact: jest.fn((callback) => {
      const mockDoc = {
        share: new Map(Object.entries(markupData).map(([k]) => [k, {}]))
      }
      callback(mockDoc)
    }),
    disconnect: jest.fn().mockResolvedValue(undefined)
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return content for document with single field', async () => {
    const mockConnection = createMockConnection({ content: '<p>Hello</p>' })
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    mockTransformer.fromYdoc.mockReturnValue('<p>Hello</p>')

    const result = await getContent(
      mockCtx,
      mockContext,
      'test-document',
      { source: 'content-blob-id' as any },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer
      }
    )

    expect(mockHocuspocus.openDirectConnection).toHaveBeenCalledWith('test-document', {
      ...mockContext,
      content: 'content-blob-id'
    })
    expect(result).toEqual({
      content: { content: '<p>Hello</p>' }
    })
    expect(mockConnection.disconnect).toHaveBeenCalled()
  })

  it('should return content for document with multiple fields', async () => {
    const mockConnection = createMockConnection({
      content: '<p>Content</p>',
      description: '<p>Description</p>'
    })
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    mockTransformer.fromYdoc.mockReturnValueOnce('<p>Content</p>').mockReturnValueOnce('<p>Description</p>')

    const result = await getContent(
      mockCtx,
      mockContext,
      'test-document',
      { source: undefined },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer
      }
    )

    expect(result).toEqual({
      content: {
        content: '<p>Content</p>',
        description: '<p>Description</p>'
      }
    })
  })

  it('should always disconnect connection even on error', async () => {
    const mockConnection = {
      transact: jest.fn(() => {
        throw new Error('Transform error')
      }),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    await expect(
      getContent(
        mockCtx,
        mockContext as any,
        'test-document',
        { source: undefined },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: mockTransformer as any
        }
      )
    ).rejects.toThrow('Transform error')

    expect(mockConnection.disconnect).toHaveBeenCalled()
  })

  it('should handle empty document', async () => {
    const mockConnection = createMockConnection({})
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const result = await getContent(
      mockCtx,
      mockContext,
      'test-document',
      { source: undefined },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer
      }
    )

    expect(result).toEqual({ content: {} })
  })

  it('should pass context with content to hocuspocus', async () => {
    const mockConnection = createMockConnection({ content: 'test' })
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    mockTransformer.fromYdoc.mockReturnValue('test')

    await getContent(
      mockCtx,
      mockContext,
      'doc-id',
      { source: 'blob-123' as any },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer
      }
    )

    expect(mockHocuspocus.openDirectConnection).toHaveBeenCalledWith(
      'doc-id',
      expect.objectContaining({
        content: 'blob-123'
      })
    )
  })
})
