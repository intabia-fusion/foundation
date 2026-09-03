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

import { WorkspaceClient } from '../workspace/workspaceClient'

jest.mock('../config', () => ({ __esModule: true, default: {} }))

/** `ensureInited` is private and the constructor talks to the platform, so drive the prototype. */
function makeClient (initClient: jest.Mock): { client: any, ensureInited: () => Promise<void> } {
  const client: any = Object.create(WorkspaceClient.prototype)
  client.initPromise = undefined
  client.initClient = initClient
  return {
    client,
    ensureInited: async () => {
      await (WorkspaceClient.prototype as any).ensureInited.call(client)
    }
  }
}

describe('WorkspaceClient init caching', () => {
  it('runs the init once while it succeeds', async () => {
    const initClient = jest.fn().mockResolvedValue(undefined)
    const { ensureInited } = makeClient(initClient)

    await ensureInited()
    await ensureInited()

    expect(initClient).toHaveBeenCalledTimes(1)
  })

  it('re-runs the init after a failure instead of caching the rejection', async () => {
    // A workspace touched while it is upgrading answers 403; the bot must recover on the next use.
    const initClient = jest.fn().mockRejectedValueOnce(new Error('Forbidden')).mockResolvedValue(undefined)
    const { ensureInited } = makeClient(initClient)

    await expect(ensureInited()).rejects.toThrow('Forbidden')
    await ensureInited()

    expect(initClient).toHaveBeenCalledTimes(2)
  })
})
