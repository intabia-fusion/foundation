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

import {
  type AccountUuid,
  type IntegrationKind,
  type PersonId,
  type PersonUuid,
  type Ref,
  type Space,
  type Timestamp,
  type WorkspaceUuid
} from '@hcengineering/core'
import { createHash, randomBytes } from 'crypto'

/** Writes only - reads are implicit, limited by `spaces`. Duplicated in account-client/src/types.ts - change both */
export type ApiKeyOperation =
  | 'issue:create'
  | 'issue:update'
  | 'issue:comment'
  | 'issue:time_report'
  | 'chat:post'
  | 'doc:create'
  | 'doc:update'

export const apiKeyOperations: ApiKeyOperation[] = [
  'issue:create',
  'issue:update',
  'issue:comment',
  'issue:time_report',
  'chat:post',
  'doc:create',
  'doc:update'
]

/** Integration kind of an API key row in `integration`/`integration_secrets`. */
export const apiKeyKind = 'webhook' as IntegrationKind

/** Lifetime of a token minted from the key. Rotation is manual: no auto-refresh once it expires. */
export const minApiKeyTokenTtlMs = 24 * 60 * 60 * 1000 // 1 day
export const maxApiKeyTokenTtlMs = 90 * 24 * 60 * 60 * 1000 // 90 days
export const defaultApiKeyTokenTtlMs = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Recognizable in leaks: secret scanners and our own log checks match on it. */
export const apiKeyPrefix = 'fus'

/** What lands in `IntegrationSecret.secret`, serialized as JSON. The key itself is never stored. */
export interface ApiKeySecret {
  keyId: string
  name: string
  masked: string
  ops: ApiKeyOperation[]
  spaces: Ref<Space>[]
  createdOn: Timestamp
  createdBy: AccountUuid
  /** Acts as its creator with their own rights, narrowed or not by `ops`/`spaces`. Absent/false = integration key. */
  personal?: boolean
  /** True = writes through any API with the principal's own rights, `ops` unused, `spaces` still
   * narrow it. A key with `ops` writes only through `/api/v1/ops`. */
  unrestricted?: boolean
  /** May be used on pod-webhook's ingest routes. A separate, independent gate from `ops`/`unrestricted` -
   * absent/false refuses ingest regardless of what the key can otherwise do. */
  incoming?: boolean
  /** When the key itself stops being usable - distinct from `tokenTtlMs`, the lifetime of tokens it issues. */
  expiresOn?: Timestamp
  /** Owner-chosen, 1-90 days. Missing on keys predating the field - treat as `defaultApiKeyTokenTtlMs`. */
  tokenTtlMs?: number
  lastUsed?: Timestamp
  revokedOn?: Timestamp
  revokedBy?: AccountUuid
}

/** `fus_<ws-short>_<64 hex>`. Hex, not base62: parts split on `_`, so the random part must not contain one. */
export function generateApiKey (workspaceUrl: string): string {
  const short = workspaceUrl
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)

  return `${apiKeyPrefix}_${short}_${randomBytes(32).toString('hex')}`
}

export function hashApiKey (key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Everything shown after creation: the prefix part plus the last 4 chars. */
export function maskApiKey (key: string): string {
  const cut = key.lastIndexOf('_')
  const head = cut < 0 ? apiKeyPrefix : key.slice(0, cut + 1)

  return `${head}...${key.slice(-4)}`
}

export function isApiKey (value: string): boolean {
  return value.startsWith(`${apiKeyPrefix}_`)
}

/** Empty is valid: a key with no write operation is a read-only key. */
export function isValidApiKeyOps (ops: unknown): ops is ApiKeyOperation[] {
  return Array.isArray(ops) && ops.every((op) => apiKeyOperations.includes(op))
}

export function isValidApiKeyTokenTtl (ttlMs: unknown): ttlMs is number {
  return typeof ttlMs === 'number' && ttlMs >= minApiKeyTokenTtlMs && ttlMs <= maxApiKeyTokenTtlMs
}

export function isApiKeyUsable (secret: ApiKeySecret, now: Timestamp = Date.now()): boolean {
  return secret.revokedOn === undefined && (secret.expiresOn === undefined || secret.expiresOn > now)
}

/** Duplicated in foundations/core/packages/account-client/src/types.ts - change both */
export interface ApiKeyInfo extends ApiKeySecret {
  socialId: PersonId
}

export interface CreatedApiKey {
  key: string
  info: ApiKeyInfo
}

/** Quotas, so the UI shows usage without a second call: `limit` counts integration keys per workspace
 * (Workspace.maxApiKeys ?? the env default), `personalLimit` counts personal keys per user. */
export interface ApiKeysList {
  keys: ApiKeyInfo[]
  limit: number
  personalLimit: number
}

export interface ApiKeyCheck {
  keyId: string
  name: string
  workspace: WorkspaceUuid
  socialId: PersonId
  personUuid: PersonUuid
  ops: ApiKeyOperation[]
  spaces: Ref<Space>[]
  /** Whether this key may be used on pod-webhook's ingest routes. */
  incoming: boolean
}
