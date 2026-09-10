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

import type { Config } from '../config'

describe('config', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Clear all relevant env variables before each test
    delete process.env.SECRET
    delete process.env.SERVICE_ID
    delete process.env.COLLABORATOR_PORT
    delete process.env.ACCOUNTS_URL
    delete process.env.INTERVAL
    delete process.env.STORAGE_RETRY_COUNT
    delete process.env.STORAGE_RETRY_INTERVAL
    jest.resetModules()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('should load config with all required env variables', () => {
    process.env.SECRET = 'test-secret'
    process.env.SERVICE_ID = 'test-service'
    process.env.COLLABORATOR_PORT = '3078'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    process.env.INTERVAL = '30000'
    process.env.STORAGE_RETRY_COUNT = '5'
    process.env.STORAGE_RETRY_INTERVAL = '50'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.Secret).toBe('test-secret')
    expect(config.ServiceID).toBe('test-service')
    expect(config.Port).toBe(3078)
    expect(config.AccountsUrl).toBe('http://localhost:3000')
    expect(config.Interval).toBe(30000)
    expect(config.StorageRetryCount).toBe(5)
    expect(config.StorageRetryInterval).toBe(50)
  })

  it('should use default values for optional env variables', () => {
    process.env.SECRET = 'test-secret'
    process.env.COLLABORATOR_PORT = '3078'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    // SERVICE_ID has a default value in config.ts

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.ServiceID).toBe('collaborator-service') // default value
    expect(config.Interval).toBe(30000)
    expect(config.StorageRetryCount).toBe(5)
    expect(config.StorageRetryInterval).toBe(50)
  })

  it('should throw error when SECRET is missing', () => {
    process.env.COLLABORATOR_PORT = '3078'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    delete process.env.SECRET

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../config')
    }).toThrow('Missing env variables: SECRET')
  })

  it('should throw error when ACCOUNTS_URL is missing', () => {
    process.env.SECRET = 'test-secret'
    process.env.COLLABORATOR_PORT = '3078'
    delete process.env.ACCOUNTS_URL

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../config')
    }).toThrow('Missing env variables: ACCOUNTS_URL')
  })

  it('should throw error with multiple missing env variables', () => {
    delete process.env.SECRET
    delete process.env.ACCOUNTS_URL

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../config')
    }).toThrow('Missing env variables: SECRET, ACCOUNTS_URL')
  })

  it('should use default ServiceID when not provided', () => {
    process.env.SECRET = 'test-secret'
    process.env.COLLABORATOR_PORT = '3078'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    delete process.env.SERVICE_ID

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.ServiceID).toBe('collaborator-service')
  })

  it('should use default Port when not provided', () => {
    process.env.SECRET = 'test-secret'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    delete process.env.COLLABORATOR_PORT

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.Port).toBe(3078)
  })

  it('should parse numeric values correctly', () => {
    process.env.SECRET = 'test-secret'
    process.env.SERVICE_ID = 'test-service'
    process.env.COLLABORATOR_PORT = '8080'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    process.env.INTERVAL = '60000'
    process.env.STORAGE_RETRY_COUNT = '10'
    process.env.STORAGE_RETRY_INTERVAL = '100'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.Port).toBe(8080)
    expect(config.Interval).toBe(60000)
    expect(config.StorageRetryCount).toBe(10)
    expect(config.StorageRetryInterval).toBe(100)
  })

  it('should handle custom ServiceID', () => {
    process.env.SECRET = 'test-secret'
    process.env.SERVICE_ID = 'custom-service'
    process.env.COLLABORATOR_PORT = '3078'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config: Config = require('../config').default

    expect(config.ServiceID).toBe('custom-service')
  })
})
