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
import type { BuildModelKey } from '@hcengineering/view'
import { injectCustomAttributes } from '../customAttributes'

describe('injectCustomAttributes', () => {
  test('returns base when customAttributes undefined', () => {
    const base: Array<string | BuildModelKey> = ['title', 'status']
    expect(injectCustomAttributes(base, undefined)).toBe(base)
  })

  test('returns base when customAttributes empty', () => {
    const base: Array<string | BuildModelKey> = ['title']
    expect(injectCustomAttributes(base, [])).toBe(base)
  })

  test('appends new custom keys with displayProps.custom', () => {
    const base: Array<string | BuildModelKey> = ['title']
    const result = injectCustomAttributes(base, ['severity', 'region'])
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('title')
    expect(result[1]).toEqual({
      key: 'severity',
      displayProps: { key: 'custom_severity', compression: true, custom: true }
    })
    expect(result[2]).toEqual({
      key: 'region',
      displayProps: { key: 'custom_region', compression: true, custom: true }
    })
  })

  test('skips keys already present as string', () => {
    const base: Array<string | BuildModelKey> = ['title', 'severity']
    const result = injectCustomAttributes(base, ['severity', 'region'])
    expect(result).toHaveLength(3)
    expect(result.map((c) => (typeof c === 'string' ? c : c.key))).toEqual(['title', 'severity', 'region'])
  })

  test('skips keys already present as BuildModelKey', () => {
    const base: Array<string | BuildModelKey> = ['title', { key: 'severity', label: undefined }]
    const result = injectCustomAttributes(base, ['severity'])
    expect(result).toBe(base)
  })

  test('handles mixin-prefixed keys', () => {
    const base: Array<string | BuildModelKey> = ['title']
    const result = injectCustomAttributes(base, ['tracker:mixin:Issue.priority'])
    expect(result).toHaveLength(2)
    const injected = result[1] as BuildModelKey
    expect(injected.key).toBe('tracker:mixin:Issue.priority')
    expect(injected.displayProps?.key).toBe('custom_tracker:mixin:Issue.priority')
    expect(injected.displayProps?.custom).toBe(true)
  })

  test('returns same reference when all custom keys already exist', () => {
    const base: Array<string | BuildModelKey> = ['title', 'severity']
    const result = injectCustomAttributes(base, ['severity'])
    expect(result).toBe(base)
  })
})
