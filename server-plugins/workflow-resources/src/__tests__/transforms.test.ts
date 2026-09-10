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

import workflow from '@hcengineering/model-workflow'
import { type WorkflowValueFunction } from '@hcengineering/workflow'
import { ALL_CONVERSIONS, applyValueFunctions } from '../post-functions/transforms'

// ToString is stringifyValue itself, which every string transform funnels its input through.
const toString = ALL_CONVERSIONS[workflow.function.ToString]

const asFunc = (_id: unknown, type: 'convert' | 'transform'): WorkflowValueFunction =>
  ({ _id, type }) as unknown as WorkflowValueFunction

describe('transforms.stringifyValue', () => {
  it.each([
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['empty string', '', ''],
    ['string', 'x', 'x'],
    ['zero', 0, '0'],
    ['false', false, 'false'],
    ['bigint', 10n, '10']
  ])('renders %s', (_name, value, expected) => {
    expect(toString(value, {})).toBe(expected)
  })

  it.each([
    ['name', { name: 'N' }, 'N'],
    ['label', { label: 'L' }, 'L'],
    ['_id', { _id: 'I' }, 'I'],
    ['name over label and _id', { name: 'N', label: 'L', _id: 'I' }, 'N'],
    ['label over _id', { label: 'L', _id: 'I' }, 'L']
  ])('picks %s off an object', (_name, value, expected) => {
    expect(toString(value, {})).toBe(expected)
  })

  // The branch an eslint no-base-to-string autofix silently rewrote to JSON.stringify.
  it.each([
    ['plain object', {}, '[object Object]'],
    ['object without name/label/_id', { a: 1 }, '[object Object]'],
    ['object whose label is an object', { name: { deep: 1 } }, '[object Object]'],
    ['array', [1, 2], '1,2'],
    ['empty array', [], '']
  ])('falls back to Object toString for %s', (_name, value, expected) => {
    expect(toString(value, {})).toBe(expected)
  })

  it('uses a custom toString when the value defines one', () => {
    expect(
      toString(
        {
          toString: () => 'custom'
        },
        {}
      )
    ).toBe('custom')
  })

  it('renders a Date through its own toString', () => {
    const date = new Date(0)
    expect(toString(date, {})).toBe(date.toString())
  })
})

describe('transforms with non-string values', () => {
  const run = (func: unknown, value: unknown, props?: Record<string, unknown>): unknown =>
    applyValueFunctions([{ func, props } as any], value, [asFunc(func, 'transform')])

  it('upper-cases an object by its name', () => {
    expect(run(workflow.function.UpperCase, { name: 'task' })).toBe('TASK')
  })

  it('appends to an object with no name', () => {
    expect(run(workflow.function.Append, { a: 1 }, { value: '!' })).toBe('[object Object]!')
  })

  it('trims an array', () => {
    expect(run(workflow.function.Trim, [' a ', 'b'])).toBe('a ,b')
  })

  it('cuts an object rendered by toString', () => {
    expect(run(workflow.function.Cut, {}, { start: 0, length: 7 })).toBe('[object')
  })
})

describe('transforms numeric and date conversions', () => {
  it('parses a number off an object name', () => {
    expect(ALL_CONVERSIONS[workflow.function.NumberFromText]({ name: '42' }, {})).toBe(42)
  })

  it('returns null for an object with no numeric rendering', () => {
    expect(ALL_CONVERSIONS[workflow.function.NumberFromText]({ a: 1 }, {})).toBeNull()
  })

  it('parses a date off an object name', () => {
    expect(ALL_CONVERSIONS[workflow.function.DateFromText]({ name: '1970-01-01T00:00:00.000Z' }, {})).toBe(0)
  })
})
