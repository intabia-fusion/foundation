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

import fs from 'fs'
import os from 'os'
import path from 'path'

const CONFIG = `
accounts:
  url: http://account:3000
  serverSecret: secret
bot:
  firstName: Julia
  lastName: AI
services:
  love:
    endpoint: http://love:8096
storage:
  config: minio
llm:
  defaultLevel: middle
  models:
    middle:
      order: 10
      label: Стандарт
      tokenMultiplier: 1
  providers:
    - id: gigachat
      provider: gigachat
      concurrency: 1
      batch: 1
      endpointConfig:
        credentials: test
      serves:
        middle: GigaChat-2
`

describe('createDefaultProvider', () => {
  it('reuses the registry instance instead of building a second one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aibot-def-')), 'config.yaml')
    fs.writeFileSync(file, CONFIG)
    process.env.CONFIG_PATH = file
    process.env.CHUNK_STORAGE_CONFIG = 'minio'
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const llms = require('../llms')
      const ctx = { info: () => {}, warn: () => {}, error: () => {} }
      // A second instance of the same provider would start a second GigaChat auth timer.
      const registry = new Map([['gigachat', { marker: 'from-registry' }]])
      expect(llms.createDefaultProvider(ctx, undefined, registry)).toBe(registry.get('gigachat'))
    })
  })
})
