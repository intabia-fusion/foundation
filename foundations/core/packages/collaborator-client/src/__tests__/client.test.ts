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

import { getClient } from '../client'
import core, { CollaborativeDoc, Doc, Ref, WorkspaceUuid } from '@hcengineering/core'

describe('CollaboratorClient', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const doc: CollaborativeDoc = {
    objectClass: core.class.Doc,
    objectId: 'doc-1' as Ref<Doc>,
    objectAttr: 'content'
  }

  it('should include ?silent=true in RPC URL when silent is true', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: { content: 'updated' } })
    })
    globalThis.fetch = mockFetch

    const client = getClient('ws-1' as WorkspaceUuid, 'token-1', 'http://localhost:3000')
    await client.updateMarkup(doc, 'new markup', { silent: true })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = mockFetch.mock.calls[0][0]
    expect(callUrl).toContain('?silent=true')
  })

  it('should not include ?silent=true in RPC URL when silent is false or omitted', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: { content: 'updated' } })
    })
    globalThis.fetch = mockFetch

    const client = getClient('ws-1' as WorkspaceUuid, 'token-1', 'http://localhost:3000')
    await client.updateMarkup(doc, 'new markup')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = mockFetch.mock.calls[0][0]
    expect(callUrl).not.toContain('?silent=true')
  })
})
