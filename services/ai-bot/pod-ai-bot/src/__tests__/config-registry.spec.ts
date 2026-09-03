//
// Copyright © 2026 Intabia Fusion
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

import fs from 'fs'
import os from 'os'
import path from 'path'

import type { AIProviderConfig } from '../config'

const HEADER = `
accounts:
  url: http://account:3000
  serverSecret: secret
bot:
  firstName: Julia
  lastName: AI
services:
  love:
    endpoint: http://love:8096
  billing:
    url: http://billing:4041
storage:
  config: minio
`

/** Load config.ts fresh against a yaml body, returning the built LLM registry. */
function loadRegistry (yamlBody: string): AIProviderConfig[] {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aibot-cfg-')), 'config.yaml')
  fs.writeFileSync(file, HEADER + yamlBody)
  process.env.CONFIG_PATH = file
  process.env.CHUNK_STORAGE_CONFIG = 'minio'
  let registry: AIProviderConfig[] = []
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    registry = require('../config').default.AIProviders
  })
  return registry
}

const MODELS = `
llm:
  defaultLevel: low
  models:
    low:
      order: 0
      label: Базовый
      tokenMultiplier: 1
      features:
        tasks: false
    high:
      order: 10
      label: Профи
      tokenMultiplier: 2
`

describe('provider registry enabled flags', () => {
  it('skips a serves entry with enabled: false', () => {
    const reg = loadRegistry(`${MODELS}
  providers:
    - id: local
      provider: openai
      concurrency: 1
      batch: 1
      serves:
        low:
          model: small
        high:
          model: big
          enabled: false
`)
    expect(Object.keys(reg[0].levels)).toEqual(['low'])
  })

  it('drops a provider with enabled: false, freeing the level for another one', () => {
    const reg = loadRegistry(`${MODELS}
  providers:
    - id: parked
      provider: openai
      enabled: false
      concurrency: 1
      batch: 1
      serves:
        low:
          model: alt
    - id: live
      provider: openai
      concurrency: 1
      batch: 1
      serves:
        low:
          model: small
`)
    expect(reg.map((p) => p.id)).toEqual(['live'])
    expect(reg[0].levels.low?.model).toBe('small')
  })

  it('serves-entry features override the level class features', () => {
    const reg = loadRegistry(`${MODELS}
  providers:
    - id: local
      provider: openai
      concurrency: 1
      batch: 1
      serves:
        low:
          model: small
          features:
            tasks: true
            talk: false
        high: big
`)
    expect(reg[0].levels.low?.features).toEqual({ tasks: true, talk: false })
    // No override -> inherited from models.high (none defined).
    expect(reg[0].levels.high?.features).toBeUndefined()
  })

  it('still rejects two live providers serving the same level', () => {
    expect(() =>
      loadRegistry(`${MODELS}
  providers:
    - id: a
      provider: openai
      concurrency: 1
      batch: 1
      serves:
        low: one
    - id: b
      provider: openai
      concurrency: 1
      batch: 1
      serves:
        low: two
`)
    ).toThrow("level 'low' is served by both")
  })
})
