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

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

jest.mock('dns')

/* eslint-disable import/first */
import * as dns from 'dns'
import { isBlockedAddress, safeFetch, ssrfPolicy, SsrfError } from '../ssrf'
import { startMockReceiver, type MockReceiver } from './mockReceiver'
/* eslint-enable import/first */

const baseOpts = {
  method: 'POST',
  headers: {},
  body: '{}',
  timeoutMs: 200,
  maxResponseBytes: 65536,
  allowInsecureHttp: false
}

// -- isBlockedAddress: every range from the plan, exhaustively, no network involved. --------------
describe('isBlockedAddress', () => {
  test.each([
    ['127.0.0.1', 4, true, 'loopback (127/8)'],
    ['127.255.255.255', 4, true, 'loopback (127/8) upper edge'],
    ['10.0.0.1', 4, true, 'private (10/8)'],
    ['10.255.255.255', 4, true, 'private (10/8) upper edge'],
    ['172.16.0.1', 4, true, 'private (172.16/12) lower edge'],
    ['172.31.255.255', 4, true, 'private (172.16/12) upper edge'],
    ['172.15.255.255', 4, false, 'just below 172.16/12'],
    ['172.32.0.0', 4, false, 'just above 172.16/12'],
    ['192.168.0.1', 4, true, 'private (192.168/16)'],
    ['192.168.255.255', 4, true, 'private (192.168/16) upper edge'],
    ['169.254.0.1', 4, true, 'link-local (169.254/16)'],
    ['169.254.169.254', 4, true, 'cloud metadata address'],
    ['169.253.255.255', 4, false, 'just below 169.254/16'],
    ['8.8.8.8', 4, false, 'public address'],
    ['93.184.216.34', 4, false, 'public address']
  ])('%s (family %i) -> blocked=%s (%s)', (address, family, expected) => {
    expect(isBlockedAddress(address, family)).toBe(expected)
  })

  test.each([
    ['::1', true, 'IPv6 loopback'],
    ['fc00::1', true, 'unique-local fc00::/7 (fc)'],
    ['fd12:3456:789a::1', true, 'unique-local fc00::/7 (fd)'],
    ['fe80::1', true, 'link-local fe80::/10, the IPv6 counterpart of 169.254/16'],
    ['febf:ffff::1', true, 'link-local upper bound'],
    ['fec0::1', false, 'just past fe80::/10'],
    ['2001:4860:4860::8888', false, 'public IPv6 (Google DNS)'],
    ['::ffff:127.0.0.1', true, 'IPv4-mapped loopback must resolve through the embedded IPv4 check'],
    ['::ffff:10.0.0.1', true, 'IPv4-mapped private address'],
    ['::ffff:8.8.8.8', false, 'IPv4-mapped public address'],
    ['::', true, 'unspecified address, connects to the local host like ::1'],
    ['::0', true, 'unspecified address, written out'],
    ['::ffff:7f00:1', true, 'IPv4-mapped loopback in hextet form'],
    ['::ffff:a00:1', true, 'IPv4-mapped private address in hextet form'],
    ['::ffff:808:808', false, 'IPv4-mapped public address in hextet form']
  ])('%s -> blocked=%s (%s)', (address, expected) => {
    expect(isBlockedAddress(address, 6)).toBe(expected)
  })
})

// -- safeFetch address policy: fully mocked dns, no real connection ever attempted. ----------------
function mockLookupSequence (...results: Array<{ address: string, family: number } | Error>): void {
  const lookup = dns.lookup as unknown as jest.Mock
  lookup.mockReset()
  for (const result of results) {
    lookup.mockImplementationOnce((_hostname: string, _opts: unknown, cb: (...args: any[]) => void) => {
      if (result instanceof Error) cb(result)
      else cb(null, [{ address: result.address, family: result.family }])
    })
  }
}

describe('safeFetch address policy', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  test('rejects a non-https URL by default', async () => {
    await expect(safeFetch('http://example.com/hook', baseOpts)).rejects.toThrow(SsrfError)
    expect(dns.lookup).not.toHaveBeenCalled()
  })

  test('a malformed URL is an SsrfError, so the caller fails it permanently instead of retrying', async () => {
    await expect(safeFetch('not a url', baseOpts)).rejects.toThrow(SsrfError)
    expect(dns.lookup).not.toHaveBeenCalled()
  })

  test('a blocked address fails the preflight check before any connection is attempted', async () => {
    mockLookupSequence({ address: '10.0.0.5', family: 4 })

    await expect(safeFetch('https://internal.example/hook', baseOpts)).rejects.toThrow(SsrfError)
    // Only the preflight lookup ran - the request never got far enough to call `lookup` a second time.
    expect(dns.lookup).toHaveBeenCalledTimes(1)
  })

  test('re-checks right before connecting: a name that resolves publicly at preflight but privately at connect time is still blocked', async () => {
    mockLookupSequence(
      { address: '8.8.8.8', family: 4 }, // preflight: looks public, passes
      { address: '10.0.0.5', family: 4 } // connect-time re-check: now resolves privately (DNS rebind)
    )

    await expect(safeFetch('https://rebinding.example/hook', baseOpts)).rejects.toThrow()
    expect(dns.lookup).toHaveBeenCalledTimes(2)
  })

  test('allowInsecureHttp only relaxes the scheme check, not the address policy', async () => {
    mockLookupSequence({ address: '192.168.1.1', family: 4 })

    await expect(safeFetch('http://internal.example/hook', { ...baseOpts, allowInsecureHttp: true })).rejects.toThrow(
      SsrfError
    )
  })

  test('devAllowedHosts exempts a listed host from the private-range block', async () => {
    mockLookupSequence({ address: '172.18.0.5', family: 4 }, { address: '172.18.0.5', family: 4 })

    await expect(
      safeFetch('http://webhook-mock:4044/receive', {
        ...baseOpts,
        allowInsecureHttp: true,
        devAllowedHosts: ['webhook-mock']
      })
    ).rejects.not.toThrow(SsrfError)
  })

  test('an unlisted host is still blocked while another one is allowed', async () => {
    mockLookupSequence({ address: '10.0.0.7', family: 4 })

    await expect(
      safeFetch('http://other-service/hook', {
        ...baseOpts,
        allowInsecureHttp: true,
        devAllowedHosts: ['webhook-mock']
      })
    ).rejects.toThrow(SsrfError)
  })

  test('the cluster denylist wins over devAllowedHosts - it cannot be opted out of', async () => {
    mockLookupSequence({ address: '10.0.0.7', family: 4 })

    await expect(
      safeFetch('http://account.svc.cluster.local/hook', {
        ...baseOpts,
        allowInsecureHttp: true,
        devAllowedHosts: ['account.svc.cluster.local']
      })
    ).rejects.toThrow(SsrfError)
  })

  test('blockedHosts adds to the built-in denylist and also beats devAllowedHosts', async () => {
    mockLookupSequence({ address: '93.184.216.34', family: 4 })

    await expect(
      safeFetch('http://vault.corp.example/hook', {
        ...baseOpts,
        allowInsecureHttp: true,
        devAllowedHosts: ['vault.corp.example'],
        blockedHosts: ['.corp.example']
      })
    ).rejects.toThrow(SsrfError)
  })
})

// -- safeFetch transport mechanics: real local server, address policy stubbed out (already covered
// exhaustively above) so these tests isolate HTTP behaviour instead of DNS/policy plumbing. ---------
describe('safeFetch transport', () => {
  let receiver: MockReceiver

  beforeEach(async () => {
    ;(dns.lookup as unknown as jest.Mock).mockImplementation(
      (hostname: string, _opts: unknown, cb: (...args: any[]) => void) => {
        cb(null, [{ address: '127.0.0.1', family: 4 }])
      }
    )
    ssrfPolicy.assertAllowed = () => {}
    receiver = await startMockReceiver()
  })

  afterEach(async () => {
    jest.resetAllMocks()
    ssrfPolicy.assertAllowed = jest.requireActual('../ssrf').ssrfPolicy.assertAllowed
    await receiver.close()
  })

  test('a 2xx response comes back with status and body, request reaches the receiver as sent', async () => {
    receiver.queueResponses({ status: 200, body: '{"ok":true}' })

    const res = await safeFetch(`${receiver.url}/hook`, {
      ...baseOpts,
      allowInsecureHttp: true,
      headers: { 'X-Test': '1' },
      body: '{"a":1}'
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('{"ok":true}')
    expect(receiver.requests).toHaveLength(1)
    expect(receiver.requests[0].headers['x-test']).toBe('1')
    expect(receiver.requests[0].body.toString('utf8')).toBe('{"a":1}')
  })

  test('a redirect response is returned as-is, never followed', async () => {
    receiver.queueResponses({ status: 302, headers: { Location: 'https://evil.example/steal' }, body: '' })

    const res = await safeFetch(`${receiver.url}/hook`, { ...baseOpts, allowInsecureHttp: true })

    expect(res.status).toBe(302)
    expect(receiver.requests).toHaveLength(1) // no second request chasing Location
  })

  test('a response over the size cap is rejected', async () => {
    receiver.queueResponses({ status: 200, body: 'x'.repeat(1000) })

    await expect(
      safeFetch(`${receiver.url}/hook`, { ...baseOpts, allowInsecureHttp: true, maxResponseBytes: 10 })
    ).rejects.toThrow(/exceeds/)
  })

  test('a request that times out is rejected', async () => {
    const slow: Server = createServer(() => {
      // Never respond.
    })
    await new Promise<void>((resolve) => slow.listen(0, resolve))
    const { port } = slow.address() as AddressInfo

    await expect(
      safeFetch(`http://127.0.0.1:${port}/hook`, { ...baseOpts, allowInsecureHttp: true, timeoutMs: 50 })
    ).rejects.toThrow(/timed out/)

    await new Promise<void>((resolve) =>
      slow.close(() => {
        resolve()
      })
    )
  })
})
