//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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

import { createRestClient, createRestTxOperations, RestClient } from '@hcengineering/api-client'
import core, { TxOperations, WorkspaceUuid } from '@hcengineering/core'
import { getTransactorEndpoint } from '@hcengineering/server-client'

export async function getClient (token: string, workspaceId: WorkspaceUuid): Promise<RestClient> {
  const endpoint = await getTransactorEndpoint(token)
  return createRestClient(endpoint, workspaceId, token)
}

// Same REST transport as getClient, wrapped into TxOperations - the only way to reach
// `apply()`/`notMatch()`, which RestClient does not expose.
export async function getTxOperations (token: string, workspaceId: WorkspaceUuid): Promise<TxOperations> {
  const endpoint = await getTransactorEndpoint(token)
  const ops = await createRestTxOperations(endpoint, workspaceId, token)
  // The service's system account has no social ids, so `account.socialIds[0]` leaves
  // `modifiedBy` undefined and the transactor rejects the batch as a bad request.
  return ops.user === undefined ? new TxOperations(ops.client, core.account.System) : ops
}
