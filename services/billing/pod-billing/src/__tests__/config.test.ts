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

const REQUIRED_ENV = { SECRET: 's', ACCOUNTS_URL: 'http://a', DB_URL: 'postgres://x', STORAGE_CONFIG: '' }

// config.ts parses env in a module-level IIFE, so each variant needs a fresh module instance.
function loadConfig (extra: Record<string, string>): any {
  const prevEnv = { ...process.env }
  Object.assign(process.env, REQUIRED_ENV, extra)
  let config: any
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    config = require('../config').default
  })
  process.env = prevEnv
  return config
}

describe('config PROVIDER_PRICES parsing', () => {
  it('parses a simple key:price pair', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'gpt4:12.5' })
    expect(config.ProviderPrices).toEqual({ gpt4: 12.5 })
  })

  it('parses multiple comma-separated pairs', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'gpt4:12.5,claude:8' })
    expect(config.ProviderPrices).toEqual({ gpt4: 12.5, claude: 8 })
  })

  it('ignores a garbage entry with a non-numeric price', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'gpt4:12.5,foo:bar' })
    expect(config.ProviderPrices).toEqual({ gpt4: 12.5 })
  })

  it('empty PROVIDER_PRICES yields no entries', () => {
    const config = loadConfig({ PROVIDER_PRICES: '' })
    expect(config.ProviderPrices).toEqual({})
  })

  // The price is the last segment, so a key may carry its own ':' (provider:model is a real key shape).
  it('keeps a colon-bearing key: only the last segment is the price', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'gpt:4:12.5' })
    expect(config.ProviderPrices).toEqual({ 'gpt:4': 12.5 })
  })

  it('parses a realistic provider:model key', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'openai:gpt-4o:12.5,gigachat:Pro:0.5' })
    expect(config.ProviderPrices).toEqual({ 'openai:gpt-4o': 12.5, 'gigachat:Pro': 0.5 })
  })

  // Number('') is 0, so a bare token without a price must be dropped rather than priced at zero.
  it('drops an entry with no price at all', () => {
    const config = loadConfig({ PROVIDER_PRICES: 'gpt4:12.5,junk' })
    expect(config.ProviderPrices).toEqual({ gpt4: 12.5 })
  })
})
