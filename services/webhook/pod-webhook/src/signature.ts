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

import { createHmac } from 'crypto'
import { type WebhookSecretEntry } from '@hcengineering/setting'

const WHSEC_PREFIX = 'whsec_'

// Standard Webhooks signs with the base64-decoded bytes after the `whsec_` prefix.
function standardKey (secret: string): Buffer {
  const b64 = secret.startsWith(WHSEC_PREFIX) ? secret.slice(WHSEC_PREFIX.length) : secret
  return Buffer.from(b64, 'base64')
}

/** One `v1,<base64>` value per active secret, space-separated - how Standard Webhooks represents a
 * signature rotation window (a receiver checks every value, matching any one of its known secrets). */
export function signStandard (secrets: string[], webhookId: string, timestampSec: number, body: string): string {
  // An empty list would produce an empty header value, which a lax receiver may read as "verified".
  if (secrets.length === 0) {
    throw new Error('cannot sign a delivery: the endpoint has no active secret')
  }
  const signedContent = `${webhookId}.${timestampSec}.${body}`
  return secrets
    .map((secret) => `v1,${createHmac('sha256', standardKey(secret)).update(signedContent).digest('base64')}`)
    .join(' ')
}

export interface SigningEndpoint {
  secrets: WebhookSecretEntry[]
}

// Identifier/attempt headers (TSK-060) plus the Standard Webhooks signature over all active secrets.
export function buildDeliveryHeaders (
  endpoint: SigningEndpoint,
  deliveryId: string,
  timestampSec: number,
  body: string,
  attempt: number
): Record<string, string> {
  const secrets = endpoint.secrets.map((s) => s.secret)

  return {
    'Content-Type': 'application/json',
    'X-Webhook-Delivery-Id': deliveryId,
    'X-Webhook-Attempt': String(attempt + 1),
    'webhook-id': deliveryId,
    'webhook-timestamp': String(timestampSec),
    'webhook-signature': signStandard(secrets, deliveryId, timestampSec, body)
  }
}
