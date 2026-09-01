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

// Reuses the real signer instead of a second HMAC implementation - verifying is "sign again and compare".
import { signStandard } from '@hcengineering/pod-webhook/src/signature'

export interface VerifyResult {
  match: boolean
  expected?: string
  received?: string
  reason?: string
}

export function verifyStandardSignature (
  secret: string,
  headers: Record<string, string>,
  rawBody: string
): VerifyResult {
  const webhookId = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  const received = headers['webhook-signature']
  if (webhookId === undefined || timestamp === undefined || received === undefined) {
    return { match: false, reason: 'missing webhook-id/webhook-timestamp/webhook-signature header' }
  }

  const expected = signStandard([secret], webhookId, Number(timestamp), rawBody)
  // webhook-signature can carry multiple space-separated `v1,<sig>` values during secret rotation.
  const match = received.split(' ').includes(expected)
  return { match, expected, received }
}
