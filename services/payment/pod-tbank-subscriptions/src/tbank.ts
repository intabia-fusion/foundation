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

// Clean-room T-Bank Acquiring API client (https://developer.tbank.ru/eacq/api).
// Implements only the subset this pod uses. Native fetch, no external deps.

import { createHash } from 'crypto'

export interface TbankLogger {
  debug?: (message: string, data?: any) => void
  error?: (message: string, data?: any) => void
}

export interface TbankConfig {
  merchantId: string // TerminalKey
  secret: string // terminal Password
  apiUrl?: string
  logger?: TbankLogger
  timeoutMs?: number
  retries?: number
}

// Every /v2 response carries these. Success:false means a business decline — returned, never thrown.
export interface TbankBaseResponse {
  Success: boolean
  ErrorCode?: string
  Message?: string
  Details?: string
  TerminalKey?: string
}

export interface InitPaymentParams {
  Amount: number // kopecks
  OrderId: string
  Description?: string
  CustomerKey?: string
  Recurrent?: 'Y'
  PayType?: 'O' | 'T'
  Language?: 'ru' | 'en'
  OperationInitiatorType?: '0' | '1' | '2' | 'R' | 'I' | 'D' | 'N'
  RedirectDueDate?: string
  NotificationURL?: string
  SuccessURL?: string
  FailURL?: string
  Receipt?: Record<string, any>
  DATA?: Record<string, any>
  [key: string]: any
}

export interface InitPaymentResponse extends TbankBaseResponse {
  PaymentId: number
  Status: string
  OrderId?: string
  Amount?: number
  PaymentURL?: string
  RebillId?: string
}

export interface ChargeParams {
  PaymentId: string | number
  RebillId: string | number
  IP?: string
  SendEmail?: boolean
  InfoEmail?: string
}

export interface ChargeResponse extends TbankBaseResponse {
  PaymentId: string | number
  Status: string
  OrderId?: string
  Amount?: number
}

export interface CancelParams {
  PaymentId: string | number
  Amount?: number
  IP?: string
  Receipt?: Record<string, any>
  ExternalRequestId?: string
}

export interface CancelResponse extends TbankBaseResponse {
  PaymentId: string | number
  Status: string
  OrderId?: string
  OriginalAmount?: number
  NewAmount?: number
}

export interface RemoveCardParams {
  CustomerKey: string
  CardId: string | number
  IP?: string
}

export interface RemoveCardResponse extends TbankBaseResponse {
  CustomerKey?: string
  CardId?: string | number
}

export interface GetStateParams {
  PaymentId: string | number
  IP?: string
}

export interface GetStateResponse extends TbankBaseResponse {
  PaymentId: string | number
  Status: string
  OrderId?: string
  Amount?: number
  RebillId?: string
  CardId?: string
}

export interface CheckOrderParams {
  OrderId: string
}

export interface CheckOrderResponse extends TbankBaseResponse {
  OrderId: string
  Payments?: Array<{ PaymentId: string | number, Status: string, Amount?: number }>
}

// Thrown after retries are exhausted on network/timeout/5xx. Callers treat any throw from a client
// method as "outcome unknown" and recheck via CheckOrder/GetState.
export class TbankTransportError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TbankTransportError'
  }
}

// Marks a 4xx: a client error the retry loop must NOT repeat (distinguished from transport in the catch).
class TbankApiError extends Error {}

// Payment states meaning the money reached the bank (for post-failure recheck).
export const TBANK_SUCCESS_STATES = new Set(['CONFIRMED', 'AUTHORIZED'])
// Terminal negative states — the charge definitely did not go through.
export const TBANK_FAILED_STATES = new Set(['REJECTED', 'DEADLINE_EXPIRED', 'CANCELED'])

const DEFAULT_API_URL = 'https://securepay.tinkoff.ru'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

export default class TbankPayments {
  private readonly merchantId: string
  private readonly secret: string
  private readonly apiUrl: string
  private readonly logger: TbankLogger
  private readonly timeoutMs: number
  private readonly retries: number

  constructor (config: TbankConfig) {
    if (config.merchantId === '' || config.secret === '') {
      throw new Error('merchantId and secret are required')
    }
    this.merchantId = config.merchantId
    this.secret = config.secret
    this.apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')
    this.logger = config.logger ?? {}
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = config.retries ?? DEFAULT_RETRIES
  }

  async initPayment (params: InitPaymentParams): Promise<InitPaymentResponse> {
    return await this.post<InitPaymentResponse>('/v2/Init', params)
  }

  async chargeRecurrent (params: ChargeParams): Promise<ChargeResponse> {
    return await this.post<ChargeResponse>('/v2/Charge', params)
  }

  async cancelPayment (params: CancelParams): Promise<CancelResponse> {
    return await this.post<CancelResponse>('/v2/Cancel', params)
  }

  async removeCard (params: RemoveCardParams): Promise<RemoveCardResponse> {
    return await this.post<RemoveCardResponse>('/v2/RemoveCard', params)
  }

  async getPaymentState (params: GetStateParams): Promise<GetStateResponse> {
    return await this.post<GetStateResponse>('/v2/GetState', params)
  }

  async checkOrder (params: CheckOrderParams): Promise<CheckOrderResponse> {
    return await this.post<CheckOrderResponse>('/v2/CheckOrder', params)
  }

  // Token per T-Bank algorithm: root scalar fields + Password, sort keys, concat values, sha256 hex.
  generateToken (params: Record<string, any>): string {
    const root: Record<string, string> = { Password: this.secret }
    for (const [key, value] of Object.entries(params)) {
      if (key === 'Token' || value === undefined || value === null) continue
      if (typeof value === 'object') continue // nested objects/arrays excluded
      root[key] = String(value) // boolean -> "true"/"false", number -> decimal
    }
    const concatenated = Object.keys(root)
      .sort()
      .map((k) => root[k])
      .join('')
    return createHash('sha256').update(concatenated, 'utf8').digest('hex')
  }

  verifyNotificationSignature (notification: Record<string, any>, receivedToken: string): boolean {
    return this.generateToken(notification) === receivedToken
  }

  private async post<T extends TbankBaseResponse>(path: string, data: Record<string, any>): Promise<T> {
    const body: Record<string, any> = { TerminalKey: this.merchantId, ...data }
    if (body.Token === undefined) {
      body.Token = this.generateToken(body)
    }
    const url = `${this.apiUrl}${path}`

    let lastErr: Error | undefined
    // retries == total attempts (min 1): retries=3 -> 3 tries, matching the spec doc.
    for (let attempt = 0; attempt < Math.max(1, this.retries); attempt++) {
      if (attempt > 0) {
        await sleep(Math.min(2 ** attempt * 100, 2000)) // exp backoff, capped
      }
      try {
        this.logger.debug?.(`[T-Bank] ${path} request`, { data: body })
        const response = await this.fetchWithTimeout(url, body)
        // 5xx -> retry as transport failure
        if (response.status >= 500) {
          lastErr = new TbankTransportError(`HTTP ${response.status} on ${path}`)
          continue
        }
        // 4xx (or any non-2xx) is not the JSON API envelope — reading it as JSON would throw and get
        // mis-retried as transport. Fail fast (retry can't fix a 4xx).
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new TbankApiError(`HTTP ${response.status} on ${path}: ${text.slice(0, 200)}`)
        }
        const json = (await response.json()) as T
        this.logger.debug?.(`[T-Bank] ${path} response`, { data: json })
        return json // Success:false returned as-is (business decline), never thrown
      } catch (err: any) {
        if (err instanceof TbankApiError) throw err // non-retriable, surface immediately
        // Network error / timeout / abort -> retry. undici hides the real reason
        // (ENOTFOUND/ECONNREFUSED/EAI_AGAIN/TLS) in err.cause — keep it or the log says only "fetch failed".
        lastErr = new TbankTransportError(describeFetchError(err))
      }
    }
    this.logger.error?.(`[T-Bank] ${path} transport failed`, { url, reason: lastErr?.message })
    throw lastErr ?? new TbankTransportError(`Request to ${path} failed`)
  }

  private async fetchWithTimeout (url: string, body: Record<string, any>): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

export function describeFetchError (err: any): string {
  const parts: string[] = [err?.message ?? String(err)]
  // depth cap guards against a self-referencing cause chain
  let cause = err?.cause
  for (let depth = 0; cause != null && depth < 5; depth++, cause = cause.cause) {
    parts.push([cause.code, cause.message ?? String(cause)].filter(Boolean).join(' '))
  }
  return parts.join(' <- ')
}

async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
