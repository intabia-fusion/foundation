import {
  AccountRole,
  AccountUuid,
  MeasureContext,
  PersonUuid,
  systemAccountUuid,
  WorkspaceUuid
} from '@hcengineering/core'
import { getMetadata } from '@hcengineering/platform'
import { decode, encode } from 'jwt-simple'
import { validate } from 'uuid'
import serverPlugin from './plugin'

/**
 * @public
 */
export interface Token {
  account: AccountUuid
  workspace: WorkspaceUuid
  extra?: Record<string, any>
  grant?: PermissionsGrant

  sub?: AccountUuid // Subject
  exp?: number // Expiration, seconds since epoch
  nbf?: number // Not valid before, seconds since epoch
}

// Permissions grant provides the token presenter access to a specific workspace
export interface PermissionsGrant {
  workspace: WorkspaceUuid
  role: AccountRole

  // Ideally we shouldn't need this but for now it's the only way to check
  // if some granted permissions are valid - the ones which can only be verified in the workspace
  grantedBy?: AccountUuid

  firstName?: string
  lastName?: string

  spaces?: string[]

  extra?: Record<string, any>
}

/**
 * @public
 */
export class TokenError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TokenError'
  }
}

const getSecret = (): string => {
  return getMetadata(serverPlugin.metadata.Secret) ?? 'secret'
}

/**
 * @public
 */
export function generateToken (
  accountUuid: PersonUuid,
  workspaceUuid?: WorkspaceUuid,
  extra?: Record<string, string>,
  secret?: string,
  options?: {
    grant?: PermissionsGrant
    nbf?: number
    exp?: number
    sub?: PersonUuid
  }
): string {
  if (!validate(accountUuid)) {
    throw new TokenError(`Invalid account uuid: "${accountUuid}"`)
  }
  if (workspaceUuid !== undefined && !validate(workspaceUuid)) {
    throw new TokenError(`Invalid workspace uuid: "${workspaceUuid}"`)
  }
  const { grant, nbf, exp, sub } = options ?? {}
  if (grant?.workspace !== undefined && !validate(grant?.workspace)) {
    throw new TokenError(`Invalid grant workspace uuid: "${grant?.workspace}"`)
  }

  if (grant != null && sub == null && (nbf == null || exp == null)) {
    throw new TokenError('nbf and exp are required when sub is not provided')
  }

  const service = getMetadata(serverPlugin.metadata.Service)
  if (service !== undefined) {
    extra = { service, ...extra }
  }

  const sanitizedGrant: PermissionsGrant | undefined =
    grant !== undefined
      ? {
          workspace: grant.workspace,
          role: grant.role,
          grantedBy: grant.grantedBy,
          firstName: grant.firstName,
          lastName: grant.lastName,
          spaces: grant.spaces,
          extra: grant.extra
        }
      : undefined

  return encode(
    {
      ...(extra !== undefined ? { extra } : {}),
      account: accountUuid,
      workspace: workspaceUuid,
      grant: sanitizedGrant,
      sub,
      exp,
      nbf
    },
    secret ?? getSecret()
  )
}

// Verified tokens, keyed by secret+token. A session reuses one token for thousands of REST
// calls, and the HMAC was 8% of transactor CPU under load. Only successes are cached.
const verifiedTokens = new Map<string, Token>()
const TOKEN_CACHE_MAX = 4096
const TOKEN_CACHE_EVICT = 512

// jwt-simple enforces nbf/exp inside decode, so a cached token has to be re-checked here -
// otherwise it would outlive its own expiry.
function isCurrent (t: Token): boolean {
  const now = Date.now()
  if (t.nbf !== undefined && now < t.nbf * 1000) return false
  if (t.exp !== undefined && now > t.exp * 1000) return false
  return true
}

/**
 * @public
 */
export function decodeToken (token: string, verify: boolean = true, secret?: string): Token {
  const key = verify ? `${secret ?? getSecret()}:${token}` : undefined
  if (key !== undefined) {
    const cached = verifiedTokens.get(key)
    if (cached !== undefined) {
      verifiedTokens.delete(key)
      if (isCurrent(cached)) {
        // Re-insert at the back: eviction walks insertion order, so a token in active use
        // must not age out just because its session started early.
        verifiedTokens.set(key, cached)
        return cached
      }
    }
  }
  try {
    const res: Token = decode(token, secret ?? getSecret(), !verify)
    if (key !== undefined) {
      if (verifiedTokens.size >= TOKEN_CACHE_MAX) {
        // Map keeps insertion order, so this drops the oldest instead of the whole live pool.
        let n = TOKEN_CACHE_EVICT
        for (const k of verifiedTokens.keys()) {
          verifiedTokens.delete(k)
          if (--n === 0) break
        }
      }
      verifiedTokens.set(key, res)
    }
    return res
  } catch (err: any) {
    throw new TokenError(err.message)
  }
}

/**
 * @public
 */
export function decodeTokenVerbose (ctx: MeasureContext, token: string): Token {
  try {
    return decodeToken(token)
  } catch (err: any) {
    try {
      const decode = decodeToken(token, false)
      ctx.warn('Failed to verify token', { ...decode })
    } catch (err2: any) {
      // Nothing to do
    }
    throw new TokenError(err.message)
  }
}

/**
 * Extract the JWT from a Cookie header. Exact match on `cookieName` (case-insensitive), else any
 * cookie name containing "token". Skips the koa `.sig` signature cookie (else it can shadow the JWT).
 * @public
 */
export function extractCookieToken (cookieHeader: string | undefined, cookieName?: string): string | undefined {
  if (cookieHeader == null) return undefined
  const target = cookieName?.toLowerCase()
  const tokenCookie = cookieHeader.split(';').find((cookie) => {
    const name = cookie.split('=')[0].trim().toLowerCase()
    if (name.endsWith('.sig')) return false
    return target != null ? name === target : name.includes('token')
  })
  if (tokenCookie === undefined) return undefined
  const value = tokenCookie.split('=').slice(1).join('=').trim()
  return value.length > 0 ? value : undefined
}

/**
 * A human admin: the account signed in with an admin email. Service and system tokens are excluded
 * even when they carry `admin: 'true'`, so a machine token can never pass an admin gate.
 */
export function isHumanAdmin (token: Pick<Token, 'account' | 'extra'>): boolean {
  return token.extra?.admin === 'true' && token.account !== systemAccountUuid && token.extra?.service === undefined
}

/** Default lifetime of an `/admin` session opened with a second factor. */
export const ADMIN_SESSION_TTL_SEC = parseInt(process.env.ADMIN_SESSION_TTL_SEC ?? '43200')

/**
 * True while the token carries a second factor (`extra.mfaAt`, seconds since epoch) stamped less
 * than `ttlSec` ago. Stateless: pods gate management endpoints on it without an account DB.
 */
export function hasAdminSession (token: Pick<Token, 'extra'>, ttlSec: number = ADMIN_SESSION_TTL_SEC): boolean {
  const mfaAt = token.extra?.mfaAt
  if (mfaAt == null) return false
  const at = typeof mfaAt === 'number' ? mfaAt : parseInt(String(mfaAt))
  return Number.isFinite(at) && Math.floor(Date.now() / 1000) - at <= ttlSec
}
