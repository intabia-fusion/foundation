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
  type DocumentVersion,
  type GetVersionsRequest,
  type GetVersionsResponse,
  decodeDocumentId
} from '@hcengineering/collaborator-client'
import { MeasureContext } from '@hcengineering/core'
import { Context } from '../../context'
import { RpcMethodParams } from '../rpc'

// json snapshots are named `<objectId>-<objectAttr>-<timestamp>`, see makeCollabJsonId
export async function getVersions (
  ctx: MeasureContext,
  context: Context,
  documentName: string,
  payload: GetVersionsRequest,
  params: RpcMethodParams
): Promise<GetVersionsResponse> {
  const { storageAdapter } = params
  const { documentId } = decodeDocumentId(documentName)
  const { objectId, objectAttr } = documentId

  const prefix = `${objectId}-${objectAttr}-`
  const versions: DocumentVersion[] = []

  const iterator = await storageAdapter.listStream(ctx, context.wsIds, prefix)
  try {
    while (true) {
      const part = await iterator.next()
      if (part.length === 0) break

      for (const blob of part) {
        // adapters may ignore the prefix hint, so filter here as well
        if (!blob._id.startsWith(prefix)) continue

        const createdOn = parseInt(blob._id.slice(prefix.length), 10)
        if (isNaN(createdOn)) continue

        versions.push({
          blobId: blob._id,
          createdOn,
          size: blob.size ?? 0
        })
      }
    }
  } finally {
    await iterator.close()
  }

  versions.sort((a, b) => b.createdOn - a.createdOn)

  return { versions }
}
