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
import type { WorkspaceUuid } from '@hcengineering/core'
import type { WebhookJobRecord } from './types'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // ~1 day, per spec

// ponytail: single-replica, in-memory, swept lazily on write. A second replica needs a shared cache
// instead - callers only ever see WebhookJobRecord.
export class WebhookStore {
  private readonly jobs = new Map<string, WebhookJobRecord>()
  // Keyed by `${keyId}:${idempotencyKey}` so one key's callers can't collide with another's.
  private readonly idempotency = new Map<string, string>() // -> jobId

  constructor (
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  private sweep (): void {
    const t = this.now()
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= t) this.jobs.delete(id)
    }
    for (const [key, jobId] of this.idempotency) {
      if (!this.jobs.has(jobId)) this.idempotency.delete(key)
    }
  }

  createJob (jobId: string, workspace: WorkspaceUuid, keyId: string): WebhookJobRecord {
    this.sweep()
    const createdAt = this.now()
    const job: WebhookJobRecord = {
      jobId,
      workspace,
      keyId,
      status: 'queued',
      createdAt,
      expiresAt: createdAt + this.ttlMs
    }
    this.jobs.set(jobId, job)
    return job
  }

  // Undo of createJob when the enqueue that follows it fails - no job will ever run for this id.
  dropJob (jobId: string): void {
    this.jobs.delete(jobId)
  }

  getJob (jobId: string): WebhookJobRecord | undefined {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.expiresAt <= this.now()) return undefined
    return job
  }

  // Returns the job created by a previous request with the same idempotency key, if still tracked.
  getIdempotentJob (keyId: string, idempotencyKey: string): WebhookJobRecord | undefined {
    const jobId = this.idempotency.get(`${keyId}:${idempotencyKey}`)
    return jobId !== undefined ? this.getJob(jobId) : undefined
  }

  putIdempotencyKey (keyId: string, idempotencyKey: string, jobId: string): void {
    this.idempotency.set(`${keyId}:${idempotencyKey}`, jobId)
  }

  // No-op if the job expired or was never tracked (e.g. pod restarted between enqueue and processing).
  markDone (jobId: string, result?: Record<string, unknown>): void {
    const job = this.jobs.get(jobId)
    if (job === undefined) return
    job.status = 'done'
    job.result = result
  }

  markFailed (jobId: string, error: string): void {
    const job = this.jobs.get(jobId)
    if (job === undefined) return
    job.status = 'failed'
    job.error = error
  }
}
