//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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

/**
 * Anticrm Platform Foundation Types
 * @packageDocumentation
 */

import type { IntlString, StatusCode } from './platform'
import platform from './platform'

/**
 * Status severity
 * @public
 */
export enum Severity {
  OK = 'OK',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR'
}

/**
 * Options for Status
 * @public
 */
export interface StatusOptions {
  timeout?: number
  propagate?: boolean
}

/**
 * Status of an operation
 * @public
 */
export class Status<P extends Record<string, any> = any> {
  readonly severity: Severity
  readonly code: StatusCode<P>
  readonly params: P
  readonly notLocalizedParams?: Record<string, IntlString>
  readonly options?: StatusOptions

  constructor (
    severity: Severity,
    code: StatusCode<P>,
    params: P,
    notLocalizedParams?: Record<string, IntlString>,
    options?: StatusOptions
  ) {
    this.severity = severity
    this.code = code
    this.params = params
    this.notLocalizedParams = notLocalizedParams
    this.options = options
  }
}

/**
 * Error object wrapping `Status`
 * @public
 */
export class PlatformError<P extends Record<string, any> = any> extends Error {
  readonly status: Status<P>

  constructor (status: Status<P>) {
    super(`${status.severity}: ${status.code} ${JSON.stringify(status.params)}`)
    this.status = status
  }

  get propagate (): boolean {
    return this.status.options?.propagate === true
  }

  get timeout (): number | undefined {
    return this.status.options?.timeout
  }
}

/**
 * Helper to check if a platform error should be propagated to client callers
 * @public
 */
export function isPlatformPropagateError (err: unknown): boolean {
  return err instanceof PlatformError && err.status?.options?.propagate === true
}

export function isInfoError (err: unknown): boolean {
  return err instanceof PlatformError && err.status?.severity === Severity.INFO
}

export function isOkError (err: unknown): boolean {
  return err instanceof PlatformError && err.status?.severity === Severity.OK
}

/**
 * OK Status
 * @public
 */
export const OK = new Status(Severity.OK, platform.status.OK, {})

/**
 * Error Status
 * @public
 */
export const ERROR = new Status(Severity.ERROR, platform.status.BadError, {})

/**
 * Error Status for Unauthorized
 * @public
 */
export const UNAUTHORIZED = new Status(Severity.ERROR, platform.status.Unauthorized, {})

/**
 * @public
 * @param message -
 * @returns
 */
export function unknownStatus (message: string, extra?: Record<string, any>): Status<any> {
  return new Status(Severity.ERROR, platform.status.UnknownError, { message, ...(extra ?? {}) })
}

/**
 * Creates unknown error status
 * @public
 */
export function unknownError (err: unknown, extra?: Record<string, any>): Status {
  if (err instanceof PlatformError) return err.status
  if (err instanceof Error) return unknownStatus(err.message, extra)
  if (typeof err === 'string') return unknownStatus(err, extra)
  return ERROR
}
