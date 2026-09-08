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

describe('config: parseNumber', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.SECRET = 'test-secret'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    delete process.env.RATE_LIMIT_MAX
    jest.resetModules()
  })

  afterAll(() => {
    process.env = originalEnv as any
  })

  it('falls back to the default on a non-numeric env value, instead of NaN', () => {
    process.env.RATE_LIMIT_MAX = 'not-a-number'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(60)
  })

  it('parses a valid numeric env value', () => {
    process.env.RATE_LIMIT_MAX = '123'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(123)
  })

  it('falls back to the default when the env value is undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(60)
  })

  it('falls back to the default on an empty string, instead of 0 (finding 2)', () => {
    process.env.RATE_LIMIT_MAX = ''

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(60)
  })

  it('falls back to the default on a whitespace-only string, instead of 0', () => {
    process.env.RATE_LIMIT_MAX = '   '

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(60)
  })

  it('honours an explicit 0', () => {
    process.env.RATE_LIMIT_MAX = '0'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.RateLimitMax).toBe(0)
  })
})

describe('config: required keys', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.SECRET = 'test-secret'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    jest.resetModules()
  })

  afterAll(() => {
    process.env = originalEnv as any
  })

  it('refuses to start when SECRET is unset', () => {
    delete process.env.SECRET

    expect(() => require('../config')).toThrow(/Missing config for attributes: Secret/)
  })
})
