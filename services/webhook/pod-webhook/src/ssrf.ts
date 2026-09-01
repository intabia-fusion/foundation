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

import * as dns from 'dns'
import * as http from 'http'
import * as https from 'https'

export class SsrfError extends Error {}

// Exact ranges from the plan (TSK-2026-09-01-027), not a general "is this public" classifier.
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['224.0.0.0', 4]
]

function ipv4ToInt (ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inIpv4Range (ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

function isBlockedIpv4 (ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => inIpv4Range(ip, base, bits))
}

function isBlockedIpv6 (address: string): boolean {
  const ip = address.toLowerCase()
  // '::' (unspecified) connects to the local host just as '::1' does.
  if (ip === '::1' || ip === '::' || ip === '::0') return true
  // IPv4-mapped (::ffff:a.b.c.d) is a literal-address way to smuggle a blocked IPv4 target past a
  // check that only looks at the IPv6 form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped !== null) return isBlockedIpv4(mapped[1])
  // The same mapping written as hextets: ::ffff:7f00:1 is 127.0.0.1.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (mappedHex !== null) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  const firstHextet = parseInt(ip.split(':')[0] !== '' ? ip.split(':')[0] : '0', 16)
  // fe80::/10 link-local, the IPv6 counterpart of the blocked 169.254/16.
  if ((firstHextet & 0xffc0) === 0xfe80) return true
  // fc00::/7 (unique local): the address's first byte has its top 7 bits set to 1111110, i.e. is 0xfc or 0xfd.
  const firstByte = (firstHextet >> 8) & 0xff
  return (firstByte & 0xfe) === 0xfc
}

export function isBlockedAddress (address: string, family: number): boolean {
  return family === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address)
}

// Cluster-internal names, refused whatever the addresses behind them resolve to and whatever the dev
// allowlist says. Suffixes match by dot boundary, so "notinternal.com" is not caught by ".internal".
const BLOCKED_HOST_SUFFIXES = ['.svc.cluster.local', '.cluster.local', '.internal', '.local']
const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', 'metadata', 'cluster.local', 'internal', 'local']

export function isBlockedHost (hostname: string, extra: string[] = []): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const match = (s: string): boolean => (s.startsWith('.') ? host.endsWith(s) : host === s)
  return BLOCKED_HOSTS.includes(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || extra.some(match)
}

async function resolveAll (hostname: string): Promise<dns.LookupAddress[]> {
  return await new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err != null) reject(err)
      else resolve(addresses)
    })
  })
}

/**
 * Order matters: the cluster-internal denylist is checked first and no setting can lift it; only then
 * may `devAllowedHosts` exempt a host from the private-range block, for a stand delivering to a mock.
 */
function assertAllowed (
  hostname: string,
  addresses: dns.LookupAddress[],
  devAllowedHosts: string[] = [],
  blockedHosts: string[] = []
): void {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (isBlockedHost(host, blockedHosts)) {
    throw new SsrfError(`host "${hostname}" is not allowed`)
  }
  if (devAllowedHosts.includes(host)) return

  const blocked = addresses.find((a) => isBlockedAddress(a.address, a.family))
  if (blocked !== undefined) {
    throw new SsrfError(`address ${blocked.address} for host "${hostname}" is not allowed`)
  }
}

// Mutable indirection so tests can stub the policy check to isolate transport mechanics from it.
export const ssrfPolicy = { assertAllowed }

export interface SafeFetchOptions {
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  maxResponseBytes: number
  /** https-only unless this (a pod-level config flag, not per-endpoint) allows http for local dev. */
  allowInsecureHttp: boolean
  /** Dev stands only: hosts exempt from the private-range block. Never lifts the cluster denylist. */
  devAllowedHosts?: string[]
  /** Extra names refused outright, on top of the built-in cluster-internal ones. */
  blockedHosts?: string[]
}

export interface SafeFetchResult {
  status: number
  body: string
}

// Resolves and range-checks the host twice: once here, and again in the `lookup` hook right before
// connecting (guards DNS rebinding). Uses http(s).request directly, so redirects are never followed.
export async function safeFetch (rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  let url: URL
  try {
    // SsrfError, not the raw TypeError: the caller treats anything else as transient and retries a
    // malformed address through the whole backoff schedule.
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError(`"${rawUrl}" is not a valid URL`)
  }
  const secure = url.protocol === 'https:'
  if (!secure && !(opts.allowInsecureHttp && url.protocol === 'http:')) {
    throw new SsrfError(`scheme "${url.protocol}" is not allowed`)
  }

  ssrfPolicy.assertAllowed(url.hostname, await resolveAll(url.hostname), opts.devAllowedHosts, opts.blockedHosts)

  const headers = { ...opts.headers }
  if (headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(opts.body))
  }

  const transport = secure ? https : http
  return await new Promise<SafeFetchResult>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const req = transport.request(
      url,
      {
        method: opts.method,
        headers,
        timeout: opts.timeoutMs,
        lookup: (
          hostname: string,
          options: dns.LookupOptions,
          callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
        ) => {
          dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (err != null) {
              callback(err, '', 4)
              return
            }
            try {
              ssrfPolicy.assertAllowed(hostname, addresses, opts.devAllowedHosts, opts.blockedHosts)
            } catch (blockedErr) {
              const asError = blockedErr instanceof Error ? blockedErr : new Error(String(blockedErr))
              callback(asError, '', 4)
              return
            }
            // net.connect asks for every address when autoSelectFamily is on - the default since Node 20 -
            // and then expects the array back. Handing it one address yields "Invalid IP address: undefined".
            if (options.all === true) callback(null, addresses)
            else callback(null, addresses[0].address, addresses[0].family)
          })
        }
      },
      (res) => {
        let received = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > opts.maxResponseBytes) {
            finish(() => {
              reject(new Error(`response exceeds ${opts.maxResponseBytes} bytes`))
            })
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          finish(() => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
          })
        })
        res.on('error', (err) => {
          finish(() => {
            reject(err)
          })
        })
      }
    )

    req.on('timeout', () => {
      finish(() => {
        reject(new Error(`request timed out after ${opts.timeoutMs}ms`))
      })
      req.destroy()
    })
    req.on('error', (err) => {
      finish(() => {
        reject(err)
      })
    })
    req.write(opts.body)
    req.end()
  })
}
