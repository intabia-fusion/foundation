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
import type { Response } from 'express'

// Single catalog of error codes returned to callers, in the Slack style: { error: <code>, message: <text> }.
export type WebhookErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  | 'invalid_payload'
  | 'not_found'
  | 'internal_error'

const messages: Record<WebhookErrorCode, string> = {
  unauthorized: 'Invalid or missing API key',
  forbidden: 'The API key is not allowed to perform this action',
  rate_limited: 'Rate limit exceeded',
  payload_too_large: 'Request body exceeds the size limit',
  invalid_payload: 'Request body is missing or has invalid required fields',
  not_found: 'Job not found',
  internal_error: 'Internal error'
}

export function sendError (res: Response, status: number, code: WebhookErrorCode, message?: string): void {
  res.status(status).json({ error: code, message: message ?? messages[code] })
}
