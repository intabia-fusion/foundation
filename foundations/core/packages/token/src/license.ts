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

import { verify as cryptoVerify } from 'node:crypto'
import { Buffer } from 'node:buffer'
// NOTE: `process` is intentionally the Node global (NOT imported) — esbuild's define replaces
// `process.env.LICENSE_PUBLIC_KEY` at build time only when it's the global, not a module binding.

// Self-host edition gating, not DRM - just a nudge for growing installs to get a key.
// dev: no baked key (unlimited, payment free); community: key set, no license (capped);
// licensed: valid license key (maxUsers from key).

export const COMMUNITY_MAX_USERS = 15

export type LicenseEdition = 'dev' | 'community' | 'licensed'

export interface License {
  maxUsers: number // 0 means unlimited
  canRunPayment: boolean
  issuedTo?: string
  expiresAt?: number // ms epoch; absent = perpetual
}

// The public key is baked into the bundle by esbuild (--define process.env.LICENSE_PUBLIC_KEY),
// stored base64-encoded single-line to survive the define step; decoded to PEM here. Empty on
// dev/CI builds -> edition is 'dev'.
function publicKeyPem (): string | undefined {
  const b64 = process.env.LICENSE_PUBLIC_KEY
  if (b64 === undefined || b64.trim().length === 0) return undefined
  try {
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/** True when this build has a baked public key (any non-dev edition). */
export function isLicensedBuild (): boolean {
  return publicKeyPem() !== undefined
}

/**
 * Verify a license key against the baked public key.
 * Key format: base64url(JSON payload) + '.' + base64url(RSA-SHA256 signature).
 * Returns the License on success, or null on: no public key (dev), missing/malformed key,
 * bad signature, or expiry.
 */
export function verifyLicense (licenseKey: string | undefined): License | null {
  const pem = publicKeyPem()
  if (pem === undefined) return null // dev build — nothing to verify against
  if (licenseKey === undefined || licenseKey.trim().length === 0) return null

  const dot = licenseKey.indexOf('.')
  if (dot <= 0) return null
  const payloadB64 = licenseKey.slice(0, dot)
  const sigB64 = licenseKey.slice(dot + 1)

  let payloadBytes: Buffer
  let sigBytes: Buffer
  try {
    payloadBytes = Buffer.from(payloadB64, 'base64url')
    sigBytes = Buffer.from(sigB64, 'base64url')
  } catch {
    return null
  }

  let ok = false
  try {
    ok = cryptoVerify('sha256', payloadBytes, pem, sigBytes)
  } catch {
    return null
  }
  if (!ok) return null

  let payload: License
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.maxUsers !== 'number' || typeof payload.canRunPayment !== 'boolean') return null
  if (payload.expiresAt !== undefined && Date.now() > payload.expiresAt) return null

  return payload
}

/** Resolve the running edition from the baked public key + the LICENSE_KEY env var. */
export function resolveEdition (licenseKey?: string): LicenseEdition {
  if (!isLicensedBuild()) return 'dev'
  return verifyLicense(licenseKey ?? process.env.LICENSE_KEY) !== null ? 'licensed' : 'community'
}

/**
 * Max users to enforce for the free/community path. Returns:
 *   dev       -> 0 (unlimited, no clamp)
 *   community -> COMMUNITY_MAX_USERS
 *   licensed  -> license.maxUsers (0 = unlimited)
 * The paid-tier path is never clamped by this — a workspace with a real subscription runs on its plan.
 */
export function resolveMaxUsers (licenseKey?: string): number {
  if (!isLicensedBuild()) return 0
  const lic = verifyLicense(licenseKey ?? process.env.LICENSE_KEY)
  return lic !== null ? lic.maxUsers : COMMUNITY_MAX_USERS
}
