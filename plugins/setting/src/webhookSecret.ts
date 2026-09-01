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

const WHSEC_PREFIX = 'whsec_'

/** `whsec_<base64 32 random bytes>` - the Standard Webhooks secret format. Lives here (not in
 * pod-webhook, a deployable) so both the UI (generates on create/rotate) and pod-webhook's
 * signature.ts (re-exports this instead of keeping its own copy) share one implementation. Uses
 * Web Crypto (`crypto.getRandomValues`/`btoa`), available as a global in both the browser and
 * Node >=20 - no Node-only `Buffer`/`crypto.randomBytes` that would break in the browser bundle. */
export function generateWebhookSecret (): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `${WHSEC_PREFIX}${btoa(binary)}`
}
