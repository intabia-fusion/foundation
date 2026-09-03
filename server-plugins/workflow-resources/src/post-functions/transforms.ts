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

import { type Ref } from '@hcengineering/core'
import workflow from '@hcengineering/model-workflow'
import { type WorkflowTransformCall, type WorkflowValueFunction } from '@hcengineering/workflow'
import { type TransformFn } from './types'

export function applyValueFunctions (
  calls: WorkflowTransformCall[],
  initialValue: unknown,
  funcs: WorkflowValueFunction[]
): unknown {
  let result = initialValue

  const funcMap = new Map((funcs ?? []).map((f) => [f._id, f]))

  const converts: WorkflowTransformCall[] = calls.filter((it) => funcMap.get(it.func)?.type === 'convert')
  const transforms: WorkflowTransformCall[] = calls.filter((it) => funcMap.get(it.func)?.type === 'transform')
  for (const c of converts) {
    result = applyConvertFunction(result, c)
  }
  for (const t of transforms) {
    result = applyTransformFunction(result, t)
  }
  return result
}

function applyConvertFunction (val: unknown, call: WorkflowTransformCall): unknown {
  const transform = ALL_CONVERSIONS[call.func]
  return transform != null ? transform(val, call.props ?? {}) : val
}

function applyTransformFunction (val: unknown, call: WorkflowTransformCall): unknown {
  const transform = ALL_TRANSFORMS[call.func]
  return transform != null ? transform(val, call.props ?? {}) : val
}

// ----------------------------------------------------------------------------
// Specific Transformer Implementations using real workflow.function.* _ids
// ----------------------------------------------------------------------------

const STRING_TRANSFORMS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  [workflow.function.UpperCase]: (v) => (v != null ? String(v).toUpperCase() : v),
  [workflow.function.LowerCase]: (v) => (v != null ? String(v).toLowerCase() : v),
  [workflow.function.Trim]: (v) => (v != null ? String(v).trim() : v),
  [workflow.function.Prepend]: (v, p) => String(p.value ?? '') + String(v ?? ''),
  [workflow.function.Append]: (v, p) => String(v ?? '') + String(p.value ?? ''),
  [workflow.function.Replace]: (v, p) => {
    if (v == null) return v
    const search = String(p.search ?? p.from ?? p.target ?? '')
    if (search == null) return v
    const replacement = String(p.replacement ?? p.to ?? '')
    return String(v).replace(search, replacement)
  },
  [workflow.function.ReplaceAll]: (v, p) => {
    if (v == null) return v
    const search = String(p.search ?? p.from ?? p.target ?? '')
    if (search == null) return v
    const replacement = String(p.replacement ?? p.to ?? '')
    return String(v).replaceAll(search, replacement)
  },
  [workflow.function.Cut]: cutString
}

function cutString (val: unknown, props: Record<string, unknown>): unknown {
  if (val == null) return val
  const str = String(val)
  const start = Number(props.start ?? 0)
  if (props.length != null) return str.substring(start, start + Number(props.length))
  if (props.end != null) return str.substring(start, Number(props.end))
  return str.substring(start)
}

export const ALL_CONVERSIONS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  [workflow.function.ToString]: stringifyValue,
  [workflow.function.TextFromNumber]: stringifyValue,
  [workflow.function.TextFromDate]: stringifyValue,
  [workflow.function.TextFromCheckbox]: stringifyValue,
  [workflow.function.NumberFromText]: parseNumber,
  [workflow.function.NumberFromDate]: parseNumber,
  [workflow.function.DateFromText]: parseDate,
  [workflow.function.DateFromNumber]: parseDate
}

function stringifyValue (val: unknown): string {
  if (val == null) return ''
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>
    const label = obj.name ?? obj.label ?? obj._id
    if (label != null) return String(label)
  }
  return String(val)
}

function parseNumber (val: unknown): number | null {
  if (val == null) return null
  if (typeof val === 'number') return val
  if (val instanceof Date) return val.getTime()
  const num = parseFloat(String(val))
  return isNaN(num) ? null : num
}

function parseDate (val: unknown): number | null {
  if (val == null) return null
  if (typeof val === 'number') return val
  const timestamp = Date.parse(String(val))
  return isNaN(timestamp) ? null : timestamp
}

const NUMBER_TRANSFORMS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  [workflow.function.Round]: (v) => (v != null ? Math.round(Number(v)) : null),
  [workflow.function.Ceil]: (v) => (v != null ? Math.ceil(Number(v)) : null),
  [workflow.function.Floor]: (v) => (v != null ? Math.floor(Number(v)) : null),
  [workflow.function.Absolute]: (v) => (v != null ? Math.abs(Number(v)) : null),
  [workflow.function.Sqrt]: (v) => (v != null ? Math.sqrt(Number(v)) : null),
  [workflow.function.Add]: (v, p) => Number(v ?? 0) + Number(p.value ?? 0),
  [workflow.function.Subtract]: (v, p) => Number(v ?? 0) - Number(p.value ?? 0),
  [workflow.function.Multiply]: (v, p) => Number(v ?? 0) * Number(p.value ?? 1),
  [workflow.function.Divide]: (v, p) => {
    const divisor = Number(p.value ?? 1)
    return divisor !== 0 ? Number(v ?? 0) / divisor : v
  },
  [workflow.function.Modulo]: (v, p) => Number(v ?? 0) % Number(p.value ?? 1),
  [workflow.function.Power]: (v, p) => Math.pow(Number(v ?? 0), Number(p.value ?? 1)),
  [workflow.function.Min]: (v, p) => Math.min(Number(v ?? 0), Number(p.value ?? 0)),
  [workflow.function.Max]: (v, p) => Math.max(Number(v ?? 0), Number(p.value ?? 0))
}

const DATE_TRANSFORMS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  [workflow.function.YearFromDate]: (v) => extractDatePart(v, (d) => d.getFullYear()),
  [workflow.function.MonthFromDate]: (v) => extractDatePart(v, (d) => d.getMonth() + 1),
  [workflow.function.DayFromDate]: (v) => extractDatePart(v, (d) => d.getDate())
}

function extractDatePart (val: unknown, getter: (d: Date) => number): number | null {
  if (val == null) return null
  const d = new Date(val as string | number | Date)
  return isNaN(d.getTime()) ? null : getter(d)
}

const ARRAY_TRANSFORMS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  [workflow.function.FirstValue]: (v) => (Array.isArray(v) ? (v.length > 0 ? v[0] : null) : v),
  [workflow.function.LastValue]: (v) => (Array.isArray(v) ? (v.length > 0 ? v[v.length - 1] : null) : v),
  [workflow.function.Random]: (v) =>
    Array.isArray(v) ? (v.length > 0 ? v[Math.floor(Math.random() * v.length)] : null) : v
}

const ALL_TRANSFORMS: Record<Ref<WorkflowValueFunction>, TransformFn> = {
  ...STRING_TRANSFORMS,
  ...NUMBER_TRANSFORMS,
  ...DATE_TRANSFORMS,
  ...ARRAY_TRANSFORMS
}
