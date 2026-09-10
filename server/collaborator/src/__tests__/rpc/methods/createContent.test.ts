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

import { createContent } from '../../../rpc/methods/createContent'
import { MeasureContext } from '@hcengineering/core'

jest.mock('@hcengineering/collaborator-client', () => ({
  decodeDocumentId: jest.fn()
}))

jest.mock('@hcengineering/collaboration', () => ({
  saveCollabJson: jest.fn()
}))

const mockDecodeDocumentId = jest.requireMock('@hcengineering/collaborator-client').decodeDocumentId
const mockSaveCollabJson = jest.requireMock('@hcengineering/collaboration').saveCollabJson

describe('createContent', () => {
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

  beforeEach(() => {
    jest.clearAllMocks()
    mockDecodeDocumentId.mockReturnValue({
      workspaceId: 'workspace-uuid',
      documentId: {
        objectClass: 'class:core:Doc' as any,
        objectId: 'object-id' as any,
        objectAttr: 'content'
      }
    })
  })

  it('should create content for single field', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map()
    }

    mockSaveCollabJson.mockResolvedValue('blob-id-123')

    const result = await createContent(
      mockCtx,
      mockContext,
      'workspace-uuid:object-id:class:core:Doc:content',
      {
        content: { content: '<p>Hello World</p>' }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: {} as any
      }
    )

    expect(mockSaveCollabJson).toHaveBeenCalledWith(
      mockCtx,
      {},
      mockContext.wsIds,
      {
        objectClass: 'class:core:Doc',
        objectId: 'object-id',
        objectAttr: 'content'
      },
      '<p>Hello World</p>'
    )
    expect(result).toEqual({
      content: { content: 'blob-id-123' }
    })
  })

  it('should create content for multiple fields', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map()
    }

    mockSaveCollabJson.mockResolvedValueOnce('blob-content').mockResolvedValueOnce('blob-description')

    const result = await createContent(
      mockCtx,
      mockContext,
      'workspace-uuid:object-id:class:core:Doc:content',
      {
        content: {
          content: '<p>Content</p>',
          description: '<p>Description</p>'
        }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: {} as any
      }
    )

    expect(mockSaveCollabJson).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      content: {
        content: 'blob-content',
        description: 'blob-description'
      }
    })
  })

  it('should throw error if document already exists', async () => {
    const mockHocuspocus = {
      documents: new Map([['workspace-uuid:object-id:class:core:Doc:content', {}]]),
      loadingDocuments: new Map()
    }

    await expect(
      createContent(
        mockCtx,
        mockContext as any,
        'workspace-uuid:object-id:class:core:Doc:content',
        {
          content: { content: '<p>Test</p>' }
        },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: {} as any
        }
      )
    ).rejects.toThrow('Document workspace-uuid:object-id:class:core:Doc:content already exists')
  })

  it('should throw error if document is loading', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map([['workspace-uuid:object-id:class:core:Doc:content', {}]])
    }

    await expect(
      createContent(
        mockCtx,
        mockContext as any,
        'workspace-uuid:object-id:class:core:Doc:content',
        {
          content: { content: '<p>Test</p>' }
        },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: {} as any
        }
      )
    ).rejects.toThrow('Document workspace-uuid:object-id:class:core:Doc:content already exists')
  })

  it('should handle empty content object', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map()
    }

    const result = await createContent(
      mockCtx,
      mockContext,
      'workspace-uuid:object-id:class:core:Doc:content',
      {
        content: {}
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: {} as any
      }
    )

    expect(mockSaveCollabJson).not.toHaveBeenCalled()
    expect(result).toEqual({ content: {} })
  })

  it('should propagate save errors', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map()
    }

    mockSaveCollabJson.mockRejectedValue(new Error('Storage error'))

    await expect(
      createContent(
        mockCtx,
        mockContext as any,
        'workspace-uuid:object-id:class:core:Doc:content',
        {
          content: { content: '<p>Test</p>' }
        },
        {
          hocuspocus: mockHocuspocus as any,
          storageAdapter: {} as any,
          transformer: {} as any
        }
      )
    ).rejects.toThrow('Storage error')
  })

  it('should decode document ID correctly', async () => {
    const mockHocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map()
    }

    mockDecodeDocumentId.mockReturnValue({
      workspaceId: 'custom-workspace',
      documentId: {
        objectClass: 'class:test:Custom' as any,
        objectId: 'custom-object' as any,
        objectAttr: 'customAttr'
      }
    })

    mockSaveCollabJson.mockResolvedValue('blob-id')

    await createContent(
      mockCtx,
      mockContext,
      'custom-workspace:custom-object:class:test:Custom:customAttr',
      {
        content: { customAttr: '<p>Test</p>' }
      },
      {
        hocuspocus: mockHocuspocus as any,
        storageAdapter: {} as any,
        transformer: {} as any
      }
    )

    expect(mockDecodeDocumentId).toHaveBeenCalledWith('custom-workspace:custom-object:class:test:Custom:customAttr')
  })
})
