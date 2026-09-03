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

/**
 * What the harness needs from a model, checked on the model itself.
 *
 * The checks run through `chatToolStep` of the real provider, so they exercise the model as the pod will
 * use it - with our system prompt and our tool definitions - rather than through a side channel.
 * The result is stored as a profile file; a run refuses to start on a model without a passing one.
 */

import fs from 'fs'
import path from 'path'

import type { ToolDefinition } from '../../llms/types'

export type SourceKind = 'local' | 'gigachat'

export interface ModelRef {
  source: SourceKind
  id: string
  /** Context window the server itself reports; unknown for sources that do not tell. */
  maxModelLen?: number
}

export type CheckStatus = 'ok' | 'fail' | 'skipped'

export interface CheckResult {
  id: string
  title: string
  required: boolean
  status: CheckStatus
  detail: string
}

export interface ModelProfile {
  source: SourceKind
  model: string
  endpoint: string
  maxModelLen?: number
  checkedAt: string
  checks: CheckResult[]
  /** Every required check passed: the model may run scenarios. */
  ok: boolean
}

export const PROFILE_DIR = path.join(__dirname, 'profiles')

/** Model ids carry slashes and dots; keep the file name recognizable but safe. */
export function profilePath (ref: ModelRef): string {
  return path.join(PROFILE_DIR, `${ref.source}_${ref.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export function readProfile (ref: ModelRef): ModelProfile | undefined {
  const file = profilePath(ref)
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ModelProfile
  } catch {
    return undefined
  }
}

export function writeProfile (profile: ModelProfile): string {
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  const file = profilePath({ source: profile.source, id: profile.model })
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n')
  return file
}

export async function listLocalModels (endpoint: string, key: string): Promise<ModelRef[]> {
  const res = await fetch(`${endpoint}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}/models`)
  const data = (await res.json()) as { data?: Array<{ id: string, max_model_len?: number | null }> }
  return (data.data ?? []).map((m) => ({
    source: 'local' as const,
    id: m.id,
    maxModelLen: m.max_model_len ?? undefined
  }))
}

/** GigaChat lists its models through the SDK; the window is not part of that answer. */
export async function listGigaChatModels (credentials: string, scope: string, baseUrl?: string): Promise<ModelRef[]> {
  const { default: GigaChat } = await import('gigachat')
  // Passing baseUrl: undefined would overwrite the SDK default and break the URL.
  const client = new GigaChat({ credentials, scope, ...(baseUrl !== undefined ? { baseUrl } : {}) })
  const models = await client.getModels()
  return (models?.data ?? []).map((m: { id: string }) => ({ source: 'gigachat' as const, id: m.id }))
}

const WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current temperature in celsius for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}

/**
 * Raw transport probes for things `chatToolStep` does not expose. Available for an OpenAI-compatible
 * endpoint; a source without them reports those checks as skipped rather than failed.
 */
export interface RawProbes {
  /** Ask for a strict json-schema answer; returns the raw content. */
  json: (schema: Record<string, unknown>, messages: Array<Record<string, unknown>>) => Promise<string>
  /** Ask for a long answer under a tiny cap; returns `finish_reason`. */
  capped: (prompt: string, maxTokens: number) => Promise<string>
}

export function localProbes (endpoint: string, key: string, model: string): RawProbes {
  const post = async (body: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, ...body })
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json()
  }
  return {
    json: async (schema, messages) => {
      const r = await post({
        messages,
        max_tokens: 400,
        response_format: { type: 'json_schema', json_schema: { name: 'verdicts', strict: true, schema } }
      })
      return r.choices?.[0]?.message?.content ?? ''
    },
    capped: async (prompt, maxTokens) => {
      const r = await post({ messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens })
      return String(r.choices?.[0]?.finish_reason)
    }
  }
}

/** The slice of LLMProvider the checks use. */
export interface CheckProvider {
  chatToolStep: (...args: any[]) => Promise<any>
}

export interface CheckEnv {
  ref: ModelRef
  /** Real provider instance; the checks call its `chatToolStep`. */
  provider: CheckProvider
  ctx: any
  level?: string
  probes?: RawProbes
}

interface StepArgs {
  ask: string
  tools?: ToolDefinition[]
  prior?: Array<{ id: string, name: string, arguments?: string, content: string }>
  lang?: string
}

async function step (env: CheckEnv, args: StepArgs): Promise<any> {
  return await env.provider.chatToolStep(
    env.ctx,
    'eval-ws',
    { role: 'user', content: args.ask },
    'direct',
    '',
    '',
    'eval-user',
    args.tools ?? [],
    args.prior ?? [],
    [],
    true,
    'eval-check',
    env.level,
    args.lang ?? 'ru'
  )
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, met: { type: 'boolean' } },
        required: ['id', 'met'],
        additionalProperties: false
      }
    }
  },
  required: ['verdicts'],
  additionalProperties: false
}

interface CheckSpec {
  id: string
  title: string
  required: boolean
  run: (env: CheckEnv) => Promise<{ status: CheckStatus, detail: string }>
}

/**
 * Each entry states something the harness relies on. `required` ones gate a scenario run; the rest
 * gate one feature (the judge needs structured output, answer continuation needs the cap signal).
 */
const CHECKS: CheckSpec[] = [
  {
    id: 'toolCall',
    title: 'зовёт инструмент нативно, аргументы валидным JSON',
    required: true,
    run: async (env) => {
      const r = await step(env, { ask: 'Какая погода в Париже? Вызови инструмент get_weather.', tools: [WEATHER_TOOL] })
      const calls = r?.toolCalls ?? []
      if (calls.length === 0) return { status: 'fail', detail: 'инструмент не вызван' }
      try {
        const args = JSON.parse(calls[0].arguments === '' ? '{}' : calls[0].arguments)
        const ok = typeof args?.city === 'string' && args.city !== ''
        return { status: ok ? 'ok' : 'fail', detail: ok ? `city=${String(args.city)}` : JSON.stringify(args) }
      } catch {
        return { status: 'fail', detail: `аргументы не JSON: ${String(calls[0].arguments).slice(0, 80)}` }
      }
    }
  },
  {
    id: 'toolLoop',
    title: 'после результата инструмента даёт финальный текст',
    required: true,
    run: async (env) => {
      const r = await step(env, {
        ask: 'Используй get_weather и скажи температуру в Париже.',
        tools: [WEATHER_TOOL],
        prior: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}', content: 'В Париже 21 градус, ясно.' }]
      })
      if ((r?.toolCalls ?? []).length > 0) return { status: 'fail', detail: 'позвал инструмент повторно' }
      const text: string = r?.content ?? ''
      const ok = text.includes('21')
      return { status: ok ? 'ok' : 'fail', detail: text.replace(/\s+/g, ' ').slice(0, 80) }
    }
  },
  {
    id: 'restraint',
    title: 'не зовёт инструмент, когда он не нужен',
    required: true,
    run: async (env) => {
      const r = await step(env, { ask: 'Привет! Как дела?', tools: [WEATHER_TOOL] })
      const calls = r?.toolCalls ?? []
      return {
        status: calls.length === 0 ? 'ok' : 'fail',
        detail: calls.length === 0 ? 'ответила текстом' : `позвала ${String(calls[0]?.name)}`
      }
    }
  },
  {
    id: 'language',
    title: 'отвечает на языке из инструкции',
    required: true,
    // Three probes, two must pass: the rule is honoured probabilistically, and a single sample
    // turns a weak model into a coin flip at the gate.
    run: async (env) => {
      const asks = ['Name three colors.', 'List two benefits of unit tests.', 'What is a good commit message?']
      const answers: string[] = []
      for (const ask of asks) {
        const r = await step(env, { ask, lang: 'ru' })
        answers.push((r?.content ?? '').replace(/\s+/g, ' '))
      }
      const ru = answers.filter((t) => /[а-яё]/i.test(t)).length
      const offender = answers.find((t) => !/[а-яё]/i.test(t))
      return {
        status: ru >= 2 ? 'ok' : 'fail',
        detail: `${ru}/3 на нужном языке${offender !== undefined ? `; например: ${offender.slice(0, 70)}` : ''}`
      }
    }
  },
  {
    id: 'structuredOutput',
    title: 'соблюдает строгую json-схему (нужно судье)',
    required: false,
    run: async (env) => {
      if (env.probes === undefined) {
        return { status: 'skipped', detail: 'источник не даёт response_format - судьёй эту модель не поставить' }
      }
      const text = await env.probes.json(VERDICT_SCHEMA, [
        { role: 'system', content: 'Верни только JSON по схеме.' },
        { role: 'user', content: 'requirements: [{id:R1,text:создана задача}] trace: задача создана' }
      ])
      try {
        const parsed = JSON.parse(text)
        const ok = Array.isArray(parsed?.verdicts) && typeof parsed.verdicts[0]?.met === 'boolean'
        return { status: ok ? 'ok' : 'fail', detail: ok ? 'схема соблюдена' : text.slice(0, 80) }
      } catch {
        return { status: 'fail', detail: `не JSON: ${text.slice(0, 80)}` }
      }
    }
  },
  {
    id: 'outputCap',
    title: 'сообщает об упоре в лимит вывода (нужно продолжению ответа)',
    required: false,
    run: async (env) => {
      if (env.probes === undefined) {
        return { status: 'skipped', detail: 'источник не даёт max_tokens отдельным запросом' }
      }
      const reason = await env.probes.capped('Расскажи подробно историю книгопечатания.', 16)
      return { status: reason === 'length' ? 'ok' : 'fail', detail: `finish_reason=${reason}` }
    }
  }
]

export async function checkModel (env: CheckEnv, endpoint: string): Promise<ModelProfile> {
  const checks: CheckResult[] = []
  for (const check of CHECKS) {
    try {
      const res = await check.run(env)
      checks.push({ id: check.id, title: check.title, required: check.required, ...res })
    } catch (err: any) {
      checks.push({
        id: check.id,
        title: check.title,
        required: check.required,
        status: 'fail',
        detail: `ошибка: ${err?.message ?? String(err)}`
      })
    }
  }
  return {
    source: env.ref.source,
    model: env.ref.id,
    endpoint,
    maxModelLen: env.ref.maxModelLen,
    checkedAt: new Date().toISOString(),
    checks,
    ok: checks.filter((c) => c.required).every((c) => c.status === 'ok')
  }
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  profile?: ModelProfile
}

/**
 * Cheap gate before a run: the profile must exist, have passed, and still describe what the server
 * serves now. A redeployed model with a different window invalidates it.
 */
export function verifyProfile (ref: ModelRef, endpoint: string): VerifyResult {
  const profile = readProfile(ref)
  if (profile === undefined) return { ok: false, reason: 'профиля нет - нужны проверки допуска' }
  if (!profile.ok) {
    const failed = profile.checks.filter((c) => c.required && c.status !== 'ok').map((c) => `${c.id} (${c.detail})`)
    return { ok: false, reason: `не прошла обязательные проверки: ${failed.join('; ')}`, profile }
  }
  if (profile.endpoint !== endpoint) {
    return { ok: false, reason: `профиль снят с ${profile.endpoint}, сейчас ${endpoint}`, profile }
  }
  if (profile.maxModelLen !== ref.maxModelLen) {
    return {
      ok: false,
      reason: `окно изменилось (${String(profile.maxModelLen)} -> ${String(ref.maxModelLen)})`,
      profile
    }
  }
  return { ok: true, profile }
}

export function profileSupports (profile: ModelProfile | undefined, checkId: string): boolean {
  return profile?.checks.some((c) => c.id === checkId && c.status === 'ok') === true
}

/** Profiles that passed, for the case when the run is started without naming a model. */
export function passingProfiles (): ModelProfile[] {
  if (!fs.existsSync(PROFILE_DIR)) return []
  return fs
    .readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8')) as ModelProfile
      } catch {
        return undefined
      }
    })
    .filter((p): p is ModelProfile => p !== undefined && p.ok)
}
