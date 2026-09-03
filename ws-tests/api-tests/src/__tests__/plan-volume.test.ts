/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { getWorkspaceToken, loadServerConfig, type ServerConfig, type WorkspaceToken } from '@hcengineering/api-client'
import { adminSessionClient, DEV_OTP } from './admin.fixtures'

// Volume (disk) limit e2e: datalake emits storage deltas to billing-usage, pod-billing
// recomputes used vs subscription.limits.storageLimitGB and publishes LimitsChanged{disk};
// datalake consumes it and rejects user uploads with 413. A plan change published by
// account-service makes billing recompute, so an upgrade lifts the block without restarts.
// Workspace api-tests-volume is dedicated: its billing state survives across tests in run.
describe('plan-volume', () => {
  const wsName = 'api-tests-volume'
  const datalakeUrl = 'http://localhost:8083/_datalake'
  let config: ServerConfig
  let owner: WorkspaceToken

  beforeAll(async () => {
    config = await loadServerConfig('http://localhost:8083')
    owner = await getWorkspaceToken(
      'http://localhost:8083',
      { email: 'user1', password: '1234', workspace: wsName },
      config
    )
  }, 30000)

  async function setStorageLimitGB (storageLimitGB: number): Promise<void> {
    const adminClient = await adminSessionClient(config)
    await adminClient.adminCreateSubscription({
      otpCode: DEV_OTP,
      workspaceUuid: owner.workspaceId,
      plan: 'business',
      limits: {
        usersLimit: 0,
        storageLimitGB,
        trafficLimitGB: 0,
        tokenLimit: 0,
        meetingMinutesLimit: 0
      }
    })
  }

  async function upload (name: string, sizeBytes: number): Promise<number> {
    // Random content -> unique sha256 ref, so every upload produces a fresh usage delta.
    const data = new Uint8Array(sizeBytes)
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.floor(Math.random() * 256)
    }
    const form = new FormData()
    form.append('file', new Blob([data], { type: 'application/octet-stream' }), name)
    const res = await fetch(`${datalakeUrl}/upload/form-data/${owner.workspaceId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: form
    })
    return res.status
  }

  /** Poll until fn returns true or deadline passes. */
  async function pollUntil (fn: () => Promise<boolean>, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await fn()) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return false
  }

  it('storage limit blocks uploads, plan upgrade lifts the block without restart', async () => {
    try {
      // ~1KB limit. On a fresh stand the workspace has 0 used; on a re-run the plan event
      // alone makes billing recompute and re-block, so the flow below tolerates both.
      await setStorageLimitGB(0.000001)

      // Push used over the limit (on re-runs this may already be rejected — that is fine).
      await upload('seed.bin', 4096)

      // Delta -> billing recompute -> LimitsChanged{disk, exhausted} -> datalake rejects with 413.
      const blocked = await pollUntil(async () => (await upload('blocked.bin', 1024)) === 413)
      expect(blocked).toBe(true)

      // Upgrade to unlimited storage: account publishes the plan event, billing recomputes
      // and publishes {disk, ok}, datalake unblocks — all without any restarts.
      await setStorageLimitGB(0)
      const unblocked = await pollUntil(async () => (await upload('unblocked.bin', 1024)) === 200)
      expect(unblocked).toBe(true)
    } finally {
      // Leave the workspace unlimited so other runs start clean.
      await setStorageLimitGB(0)
    }
  }, 120000)
})
