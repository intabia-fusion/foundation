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

import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('config: plan config validation', () => {
  const originalEnv = { ...process.env }
  let dir: string

  const writeConfig = (yaml: string): string => {
    const path = join(dir, `plan-${Math.random().toString(36).slice(2)}.yaml`)
    writeFileSync(path, yaml)
    return path
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-config-'))
  })

  beforeEach(() => {
    process.env.SECRET = 'test-secret'
    process.env.ACCOUNTS_URL = 'http://localhost:3000'
    process.env.FRONT_URL = 'http://localhost:8080'
    process.env.PROVIDER = 'mock'
    delete process.env.PLAN_CONFIG
    jest.resetModules()
  })

  afterAll(() => {
    process.env = originalEnv as any
  })

  it('loads a config where every plan sets windowMonthLimit', () => {
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  start:
    free: true
    windowMonthLimit: 100000
  business:
    priceMonthlyPerUser: 499
    windowMonthLimit: 300000
`)

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default

    expect(config.PlanConfig).toBe(process.env.PLAN_CONFIG)
  })

  it('accepts an explicit 0 — that is the "unlimited" opt-in', () => {
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  corporation:
    contactSales: true
    windowMonthLimit: 0
`)

    expect(() => require('../config')).not.toThrow()
  })

  it('refuses to start when a plan has no windowMonthLimit', () => {
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  start:
    free: true
  business:
    priceMonthlyPerUser: 499
    windowMonthLimit: 300000
`)

    expect(() => require('../config')).toThrow(/windowMonthLimit missing for plans: start/)
  })

  it('names every offending plan, not just the first', () => {
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  start:
    free: true
  corporation:
    contactSales: true
`)

    expect(() => require('../config')).toThrow(/windowMonthLimit missing for plans: start, corporation/)
  })

  it('refuses to start when a trial block has no windowMonthLimit', () => {
    // Without it the trial inherits business's per-seat window times the trial seat cap: on prod that
    // was 300000 * 1000 = 300M tokens handed to a 14-day trial.
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  business:
    priceMonthlyPerUser: 499
    windowMonthLimit: 300000
trial:
  plan: business
  days: 14
  usersLimit: 1000
`)

    expect(() => require('../config')).toThrow(/trial.windowMonthLimit missing/)
  })

  it('accepts a config with no trial block at all', () => {
    // Dropping `trial:` is a supported setup: new workspaces go straight to the free plan.
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  business:
    priceMonthlyPerUser: 499
    windowMonthLimit: 300000
`)

    expect(() => require('../config')).not.toThrow()
  })

  it('accepts a trial that sets its window', () => {
    process.env.PLAN_CONFIG = writeConfig(`
plans:
  business:
    priceMonthlyPerUser: 499
    windowMonthLimit: 300000
trial:
  plan: business
  days: 14
  usersLimit: 1000
  windowMonthLimit: 1000000
`)

    expect(() => require('../config')).not.toThrow()
  })

  it('refuses to start when the plan config file is absent', () => {
    process.env.PLAN_CONFIG = join(dir, 'does-not-exist.yaml')

    expect(() => require('../config')).toThrow(/Plan config file not found/)
  })

  it('refuses to start when PLAN_CONFIG is unset', () => {
    expect(() => require('../config')).toThrow(/Missing config for attributes: PlanConfig/)
  })
})
