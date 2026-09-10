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

import { updateContent } from '../../../rpc/methods/updateContent'
import { Doc as YDoc } from 'yjs'
import { MeasureContext } from '@hcengineering/core'

jest.mock('yjs', () => {
  const actual = jest.requireActual('yjs')
  return {
    ...actual,
    applyUpdate: jest.fn(),
    encodeStateAsUpdate: jest.fn()
  }
})

const mockApplyUpdate = jest.requireMock('yjs').applyUpdate
const mockEncodeStateAsUpdate = jest.requireMock('yjs').encodeStateAsUpdate

describe('updateContent', () => {
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

  const createMockYDoc = (): { doc: any, fragments: Map<string, any> } => {
    const fragments = new Map()
    const doc = {
      getXmlFragment: jest.fn((field) => {
        if (!fragments.has(field)) {
          fragments.set(field, {
            length: 10,
            delete: jest.fn()
          })
        }
        return fragments.get(field)
      }),
      transact: jest.fn((callback) => callback()),
      share: new Map()
    }
    return { doc, fragments }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockEncodeStateAsUpdate.mockReturnValue(new Uint8Array([1, 2, 3]))
  })

  it('should update content for single field', async () => {
    const { doc } = createMockYDoc()
    const mockConnection = {
      transact: jest.fn((callback) => callback(doc)),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    const result = await updateContent(
      mockCtx,
      mockContext,
      'test-document',
      {
        content: { content: '<p>Updated Content</p>' }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer as any
      }
    )

    expect(mockTransformer.toYdoc).toHaveBeenCalledWith('<p>Updated Content</p>', 'content')
    expect(mockHocuspocus.openDirectConnection).toHaveBeenCalledWith('test-document', mockContext)
    expect(mockConnection.transact).toHaveBeenCalled()
    expect(mockConnection.disconnect).toHaveBeenCalled()
    expect(result).toEqual({})
  })

  it('should update content for multiple fields', async () => {
    const { doc } = createMockYDoc()
    const mockConnection = {
      transact: jest.fn((callback) => callback(doc)),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    await updateContent(
      mockCtx,
      mockContext,
      'test-document',
      {
        content: {
          content: '<p>Content</p>',
          description: '<p>Description</p>'
        }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer as any
      }
    )

    expect(mockTransformer.toYdoc).toHaveBeenCalledTimes(2)
    expect(mockTransformer.toYdoc).toHaveBeenCalledWith('<p>Content</p>', 'content')
    expect(mockTransformer.toYdoc).toHaveBeenCalledWith('<p>Description</p>', 'description')
  })

  it('should clear existing content before applying updates', async () => {
    const { doc } = createMockYDoc()
    const mockConnection = {
      transact: jest.fn((callback) => callback(doc)),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    await updateContent(
      mockCtx,
      mockContext,
      'test-document',
      {
        content: { content: '<p>New Content</p>' }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer as any
      }
    )

    const fragment = doc.getXmlFragment('content')
    expect(fragment.delete).toHaveBeenCalledWith(0, 10)
    expect(mockApplyUpdate).toHaveBeenCalled()
  })

  it('should always disconnect connection even on error', async () => {
    const mockConnection = {
      transact: jest.fn(() => {
        throw new Error('Update error')
      }),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    await expect(
      updateContent(
        mockCtx,
        mockContext as any,
        'test-document',
        {
          content: { content: '<p>Content</p>' }
        },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: mockTransformer as any
        }
      )
    ).rejects.toThrow('Update error')

    expect(mockConnection.disconnect).toHaveBeenCalled()
  })

  it('should handle connection errors', async () => {
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockRejectedValue(new Error('Connection failed'))
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    await expect(
      updateContent(
        mockCtx,
        mockContext as any,
        'test-document',
        {
          content: { content: '<p>Content</p>' }
        },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: mockTransformer as any
        }
      )
    ).rejects.toThrow('Connection failed')
  })

  it('should handle empty content', async () => {
    const { doc } = createMockYDoc()
    const mockConnection = {
      transact: jest.fn((callback) => callback(doc)),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    const mockHocuspocus = {
      openDirectConnection: jest.fn().mockResolvedValue(mockConnection)
    }

    const mockTransformer = {
      toYdoc: jest.fn().mockReturnValue(new YDoc())
    }

    const result = await updateContent(
      mockCtx,
      mockContext,
      'test-document',
      {
        content: {}
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: mockTransformer as any
      }
    )

    expect(mockTransformer.toYdoc).not.toHaveBeenCalled()
    expect(mockConnection.transact).toHaveBeenCalled()
    expect(result).toEqual({})
  })
})
