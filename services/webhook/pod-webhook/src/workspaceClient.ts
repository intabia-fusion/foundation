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

import { getClient as getAccountClient } from '@hcengineering/account-client'
import { createRestClient, type RestClient } from '@hcengineering/api-client'
import {
  SocialIdType,
  systemAccountUuid,
  type AccountUuid,
  type MeasureContext,
  type PersonUuid,
  type Ref,
  type Space,
  type WorkspaceUuid
} from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'

import type { Config } from './config'

export interface KeyGrant {
  keyId: string
  name: string
  personUuid: PersonUuid
  ops: string[]
  spaces: Ref<Space>[]
}

/** Same shape `loginWithApiKey` issues - keep in step. Issued here so the key itself never enters the queue. */
function issueKeyToken (grant: KeyGrant, workspace: WorkspaceUuid): string {
  return generateToken(grant.personUuid as unknown as AccountUuid, workspace, {
    apikey: grant.keyId,
    ...(grant.ops.length > 0 ? { apiops: grant.ops.join(',') } : {}),
    ...(grant.spaces.length > 0 ? { apispaces: grant.spaces.join(',') } : {})
  })
}

interface TransactorEndpoint {
  transactorUrl: string
  collaboratorEndpoint?: string
}

// ponytail: cached for the process lifetime and identity-independent, so both target helpers share it.
// A workspace moved to another transactor is not noticed until restart.
const endpoints = new Map<WorkspaceUuid, Promise<TransactorEndpoint>>()

async function loadEndpoint (config: Config, workspace: WorkspaceUuid, token: string): Promise<TransactorEndpoint> {
  const wsInfo = await getAccountClient(config.AccountsUrl, token).selectWorkspace('', 'internal')
  const transactorUrl = wsInfo.endpoint.replace('ws://', 'http://').replace('wss://', 'https://')
  return { transactorUrl, collaboratorEndpoint: wsInfo.collaboratorEndpoint }
}

export interface TransactorTarget {
  /** The token used to reach the transactor - both the REST client below and any `/api/v1/ops` call use it. */
  token: string
  transactorUrl: string
  /** For `uploadMarkup` only - the pod no longer builds a `TxOperations`/`Client` over this. */
  rest: RestClient
}

async function resolveTarget (config: Config, workspace: WorkspaceUuid, token: string): Promise<TransactorTarget> {
  let cached = endpoints.get(workspace)
  if (cached === undefined) {
    cached = loadEndpoint(config, workspace, token)
    endpoints.set(workspace, cached)
    cached.catch(() => endpoints.delete(workspace)) // don't cache a failed attempt
  }
  const { transactorUrl, collaboratorEndpoint } = await cached

  const rest = createRestClient(transactorUrl, workspace, token, collaboratorEndpoint)
  return { token, transactorUrl, rest }
}

// ponytail: cached for the process lifetime, keyed by (workspace, keyId) - a key rename needs a pod
// restart to reach the workspace Person. Acceptable: the Person doc is a display-name convenience.
const ensuredPersons = new Set<string>()

/**
 * Materializes the key's own contact.class.Person + SocialIdentity(WEBHOOK) in the workspace, the
 * same mechanism a human's login flow uses (ensureEmployeeForPerson via /api/v1/ensure-person), with
 * addGuestEmployee omitted so no Employee mixin is added - the integration must not take a seat.
 * Without this, the transactor still authors transactions under the key's social id, but the UI has
 * nothing to resolve it to and falls back to "System". Best-effort: a space-scoped key without
 * contact.space.Contacts in its grant would get Forbidden here - never let that block delivery.
 */
async function ensureIntegrationPerson (
  ctx: MeasureContext,
  target: TransactorTarget,
  workspace: WorkspaceUuid,
  grant: KeyGrant
): Promise<void> {
  const cacheKey = `${workspace}:${grant.keyId}`
  if (ensuredPersons.has(cacheKey)) return
  try {
    await target.rest.ensurePerson(SocialIdType.WEBHOOK, grant.keyId, grant.name, '')
    ensuredPersons.add(cacheKey)
  } catch (err) {
    ctx.warn('webhook: failed to ensure integration person', { workspace, keyId: grant.keyId, err })
  }
}

/** Acts as the integration account, never as a service: the transactor applies the key's own limits. */
export async function getTransactorTarget (
  ctx: MeasureContext,
  config: Config,
  workspace: WorkspaceUuid,
  grant: KeyGrant
): Promise<TransactorTarget> {
  const target = await resolveTarget(config, workspace, issueKeyToken(grant, workspace))
  await ensureIntegrationPerson(ctx, target, workspace, grant)
  return target
}

// For the delivery worker: no API key behind an event, so it acts as the platform itself (a system
// token) rather than impersonating an integration.
export async function getSystemTransactorTarget (config: Config, workspace: WorkspaceUuid): Promise<TransactorTarget> {
  const token = generateToken(systemAccountUuid, workspace, { service: 'webhook' })
  return await resolveTarget(config, workspace, token)
}
