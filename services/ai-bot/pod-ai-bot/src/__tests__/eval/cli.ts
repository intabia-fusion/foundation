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
 * One entry point for scenario runs: pick the judge, pick the model under test, clear both, run.
 *
 *   rushx eval                 interactive: judge -> model under test -> checks -> scenarios
 *   rushx eval models          list what the sources serve
 *   rushx eval check [--all]   only (re)take the capability profile
 *   rushx eval judge           check a judge against reference traces before trusting it
 *
 * Non-interactive (CI, scripts): --model / --judge (or AI_BOT_E2E_MODEL / AI_BOT_EVAL_JUDGE_MODEL),
 * prefixed with the source when it is not local: `gigachat:GigaChat-2-Max`. Nothing is asked then,
 * and a model without a passing profile stops the run instead of quietly producing numbers.
 */

import path from 'path'
import readline from 'readline/promises'

import { judgeTrace } from './judge'
import {
  checkModel,
  listGigaChatModels,
  listLocalModels,
  localProbes,
  passingProfiles,
  profileSupports,
  readProfile,
  verifyProfile,
  writeProfile,
  type ModelProfile,
  type ModelRef,
  type SourceKind
} from './capabilities'

const ENDPOINT = process.env.AI_BOT_E2E_URL ?? 'http://127.0.0.1:8000/v1'
const KEY = process.env.AI_BOT_E2E_KEY ?? '1234'
// GIGACHAT_AUTH_KEY is what the stand env calls the same base64(client_id:secret).
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS ?? process.env.GIGACHAT_AUTH_KEY ?? ''
const GIGA_SCOPE = process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS'
const GIGA_BASE_URL = process.env.GIGACHAT_BASE_URL
const SCENARIOS = path.join(__dirname, 'scenarios')

const interactive = process.stdin.isTTY && process.stdout.isTTY

interface Args {
  command: 'run' | 'models' | 'check' | 'judge'
  model?: string
  judge?: string
  all: boolean
  yes: boolean
  noJudge: boolean
  runs: number
  report?: string
  only?: string
  /** Context window override: sources that do not report it (GigaChat) need it stated. */
  window?: number
}

function parseArgs (argv: string[]): Args {
  const args: Args = {
    command: 'run',
    model: process.env.AI_BOT_E2E_MODEL,
    judge: process.env.AI_BOT_EVAL_JUDGE_MODEL,
    all: false,
    yes: false,
    noJudge: false,
    runs: Number(process.env.AI_BOT_EVAL_RUNS ?? '1'),
    report: process.env.AI_BOT_EVAL_REPORT,
    window: process.env.AI_BOT_EVAL_WINDOW !== undefined ? Number(process.env.AI_BOT_EVAL_WINDOW) : undefined
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'models' || a === 'check' || a === 'run' || a === 'judge') args.command = a
    else if (a === '--all') args.all = true
    else if (a === '--yes' || a === '-y') args.yes = true
    else if (a === '--no-judge') args.noJudge = true
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--judge') args.judge = argv[++i]
    else if (a === '--runs') args.runs = Number(argv[++i])
    else if (a === '--report') args.report = argv[++i]
    else if (a === '--scenario') args.only = argv[++i]
    else if (a === '--window') args.window = Number(argv[++i])
    else if (!a.startsWith('-') && args.model === undefined) args.model = a
  }
  return args
}

async function ask (question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------- sources

async function loadSource (source: SourceKind): Promise<ModelRef[]> {
  if (source === 'local') return await listLocalModels(ENDPOINT, KEY)
  if (GIGA_CREDENTIALS === '') {
    console.error('  (gigachat: нет GIGACHAT_CREDENTIALS / GIGACHAT_AUTH_KEY - облачные модели пропущены)')
    return []
  }
  return await listGigaChatModels(GIGA_CREDENTIALS, GIGA_SCOPE, GIGA_BASE_URL)
}

async function loadAllModels (): Promise<ModelRef[]> {
  const out: ModelRef[] = []
  for (const source of ['local', 'gigachat'] as SourceKind[]) {
    try {
      out.push(...(await loadSource(source)))
    } catch (err: any) {
      // A source that is not configured or not up must not stop the one that is.
      console.error(`  (${source}: ${err?.message ?? String(err)})`)
    }
  }
  return out
}

function endpointOf (ref: ModelRef): string {
  return ref.source === 'local' ? ENDPOINT : (GIGA_BASE_URL ?? 'gigachat')
}

function label (ref: ModelRef): string {
  return ref.source === 'local' ? ref.id : `${ref.source}:${ref.id}`
}

/** `gigachat:Model` or a bare id, which means the local source. */
function parseRef (spec: string, served: ModelRef[]): ModelRef | undefined {
  const [maybeSource, ...rest] = spec.split(':')
  const source: SourceKind = maybeSource === 'gigachat' || maybeSource === 'local' ? maybeSource : 'local'
  const id = rest.length > 0 ? rest.join(':') : spec
  return served.find((m) => m.source === source && m.id === id)
}

// ---------------------------------------------------------------------------- printing

function profileState (ref: ModelRef): string {
  const profile = readProfile(ref)
  if (profile === undefined) return 'профиля нет'
  if (!profile.ok) {
    const failed = profile.checks.filter((c) => c.required && c.status !== 'ok').map((c) => c.id)
    return `НЕ ПРОШЛА (${failed.join(', ')})`
  }
  if (profile.maxModelLen !== ref.maxModelLen) return 'профиль устарел (окно изменилось)'
  const judge = profileSupports(profile, 'structuredOutput') ? ', годна судьёй' : ''
  return `годна, ${profile.checkedAt.slice(0, 10)}${judge}`
}

function printModels (served: ModelRef[]): void {
  console.log('')
  served.forEach((ref, i) => {
    const len = ref.maxModelLen !== undefined ? String(ref.maxModelLen) : '?'
    console.log(`  ${String(i + 1).padStart(2)}. ${label(ref).padEnd(48)} окно ${len.padEnd(8)} ${profileState(ref)}`)
  })
  console.log('')
}

function printProfile (profile: ModelProfile): void {
  for (const check of profile.checks) {
    const mark = check.status === 'ok' ? 'ok  ' : check.status === 'skipped' ? '--  ' : check.required ? 'FAIL' : 'нет '
    console.log(`  ${mark} ${check.id.padEnd(18)} ${check.title}`)
    if (check.status !== 'ok') console.log(`       ${check.detail}`)
  }
  console.log(`  итог: ${profile.ok ? 'модель годна для прогонов' : 'модель НЕ годна'}`)
}

// ---------------------------------------------------------------------------- providers

/** config.ts validates env at import time, so it must be planted before any provider is loaded. */
function bootstrapEnv (model: string): void {
  process.env.OPENAI_API_KEY = KEY
  process.env.OPENAI_BASE_URL = ENDPOINT
  process.env.OPENAI_MODEL = model
  process.env.OPENAI_SUMMARY_MODEL = model
  process.env.OPENAI_TRANSLATE_MODEL = model
  process.env.BILLING_URL = '' // billUsage becomes a no-op
  process.env.ACCOUNTS_URL ??= 'http://localhost:3000'
  process.env.SERVER_SECRET ??= 'secret'
  process.env.FIRST_NAME ??= 'Юля'
  process.env.LAST_NAME ??= 'ИИ'
  process.env.STORAGE_CONFIG ??= 'minio|localhost:9000?accessKey=x&secretKey=y'
  process.env.CHUNK_STORAGE_CONFIG ??= 'minio|localhost:9000?accessKey=x&secretKey=y'
}

/** Window in effect: what the source reports, else --window, else a conservative default. */
let windowOverride: number | undefined

function windowOf (ref: ModelRef): number {
  return ref.maxModelLen ?? windowOverride ?? 32000
}

async function createProvider (ref: ModelRef, ctx: any): Promise<any> {
  const levels = {
    high: {
      model: ref.id,
      tokenMultiplier: 1,
      order: 0,
      label: 'Eval',
      // The window the source itself reports, not a stand config that may disagree with it.
      capabilities: { maxContextTokens: windowOf(ref), maxOutputTokens: 4096 }
    }
  }
  if (ref.source === 'gigachat') {
    const GigaChatProvider = (await import('../../llms/gigachat')).default
    return new GigaChatProvider(ctx, {
      id: 'eval-gigachat',
      provider: 'gigachat',
      concurrency: 1,
      batch: 1,
      endpoint: GIGA_BASE_URL,
      endpointConfig: { credentials: GIGA_CREDENTIALS, scope: GIGA_SCOPE },
      levels
    } as any)
  }
  const OpenAIProvider = (await import('../../llms/openai')).default
  return new OpenAIProvider(ctx, { id: 'eval', provider: 'openai', concurrency: 1, batch: 1, levels } as any)
}

async function newCtx (): Promise<any> {
  const { MeasureMetricsContext, newMetrics } = await import('@hcengineering/core')
  return new MeasureMetricsContext('eval', {}, {}, newMetrics())
}

// ---------------------------------------------------------------------------- choosing

async function chooseFromList (served: ModelRef[], prompt: string): Promise<ModelRef | undefined> {
  printModels(served)
  const answer = await ask(`${prompt} [1-${served.length}, Enter - отмена]: `)
  if (answer === '') return undefined
  const index = Number(answer)
  if (Number.isInteger(index) && index >= 1 && index <= served.length) return served[index - 1]
  return parseRef(answer, served)
}

async function chooseModel (
  served: ModelRef[],
  spec: string | undefined,
  prompt: string,
  fallback?: ModelRef
): Promise<ModelRef | undefined> {
  if (spec !== undefined && spec !== '') {
    const found = parseRef(spec, served)
    if (found === undefined) {
      console.error(`Модель ${spec} не найдена. Доступны: ${served.map(label).join(', ')}`)
    }
    return found
  }
  if (!interactive) {
    if (fallback !== undefined) return fallback
    const passing = passingProfiles()
    if (passing.length === 1) return served.find((m) => m.source === passing[0].source && m.id === passing[0].model)
    console.error(
      passing.length === 0
        ? 'Модель не выбрана и проверенных моделей нет. Запустите `rushx eval` в терминале или задайте --model.'
        : `Проверенных несколько: ${passing.map((p) => `${p.source}:${p.model}`).join(', ')}. Задайте --model.`
    )
    return undefined
  }
  return (await chooseFromList(served, prompt)) ?? fallback
}

/** Everything between "a model was named" and "it may be used". */
async function clearModel (ref: ModelRef, args: Args, purpose: string): Promise<ModelProfile | undefined> {
  let verdict = verifyProfile(ref, endpointOf(ref))
  if (verdict.ok) {
    console.log(`${label(ref)} (${purpose}): профиль в порядке, снят ${verdict.profile?.checkedAt.slice(0, 10) ?? '?'}`)
    return verdict.profile
  }

  console.log(`\n${label(ref)} (${purpose}): ${verdict.reason ?? 'профиль не годен'}`)
  const failedBefore = verdict.profile !== undefined && !verdict.profile.ok
  if (!args.yes) {
    if (!interactive) return undefined
    // Re-checking a model that already failed is usually pointless; make it a deliberate answer.
    const question = failedBefore ? 'Прогнать проверки заново? [y/N]: ' : 'Прогнать проверки допуска сейчас? [Y/n]: '
    const answer = (await ask(question)).toLowerCase()
    const yes = failedBefore ? answer === 'y' : answer !== 'n'
    if (!yes) return undefined
  }

  console.log(`\nПроверяю ${label(ref)}...`)
  bootstrapEnv(ref.id)
  const ctx = await newCtx()
  const provider = await createProvider(ref, ctx)
  const profile = await checkModel(
    {
      ref,
      provider,
      ctx,
      level: 'high',
      probes: ref.source === 'local' ? localProbes(ENDPOINT, KEY, ref.id) : undefined
    },
    endpointOf(ref)
  )
  printProfile(profile)
  console.log(`  профиль: ${writeProfile(profile)}`)
  verdict = verifyProfile(ref, endpointOf(ref))
  return verdict.ok ? profile : undefined
}

/**
 * The judge is chosen first: it is the measuring instrument, and what it can do decides how the run
 * is judged at all. Picking none is a valid answer - then only the deterministic asserts count.
 */
async function chooseJudge (served: ModelRef[], args: Args): Promise<ModelRef | undefined> {
  if (args.noJudge) return undefined
  if (args.judge !== undefined && args.judge !== '') return parseRef(args.judge, served)
  if (!interactive) {
    // Nothing named and nobody to ask: judging is the optional half, so the run goes on without it.
    return undefined
  }

  console.log('\nСудья оценивает семантику по трассе. Детерминированные проверки от него не зависят')
  console.log('и работают всегда; судья нужен там, где итог нельзя проверить сравнением.')
  console.log('Судьёй может быть только модель со строгим JSON (проверка structuredOutput).')
  printModels(served)
  const answer = await ask(`Кто судья? [1-${served.length}, 0 - без судьи]: `)
  if (answer === '' || answer === '0') return undefined
  const index = Number(answer)
  if (Number.isInteger(index) && index >= 1 && index <= served.length) return served[index - 1]
  return parseRef(answer, served)
}

// ---------------------------------------------------------------------------- run

async function runScenarios (ref: ModelRef, judge: ModelRef | undefined, args: Args): Promise<boolean> {
  bootstrapEnv(ref.id)
  // Судья ходит своим транспортом (строгий json-schema), а не через провайдера тестируемой модели.
  const judgeCfg =
    judge !== undefined && judge.source === 'local' ? { endpoint: ENDPOINT, key: KEY, model: judge.id } : undefined
  if (judge !== undefined && judgeCfg === undefined) {
    console.log(
      `Судья ${label(judge)} не с локального эндпоинта - строгий JSON недоступен, оценка только по проверкам.`
    )
  }
  const { loadScenario, renderReport, runScenario, scenarioFiles } = await import('./runner')
  const { summarizeVerdicts } = await import('./judge')
  const ctx = await newCtx()
  const provider = await createProvider(ref, ctx)

  const files = scenarioFiles(SCENARIOS).filter(
    (f) => args.only === undefined || path.basename(f, '.yaml').includes(args.only)
  )
  if (files.length === 0) {
    console.error(`Сценарии не найдены в ${SCENARIOS}`)
    return false
  }

  console.log(`\nМодель: ${label(ref)} · судья: ${judge !== undefined ? label(judge) : 'нет'}`)
  console.log(`Сценариев: ${files.length}, прогонов каждого: ${args.runs}\n`)

  const traces = []
  for (const file of files) {
    const scenario = loadScenario(file)
    for (let run = 1; run <= args.runs; run++) {
      const name = args.runs > 1 ? `${scenario.name} (${run}/${args.runs})` : scenario.name
      process.stdout.write(`  ${name.padEnd(44)}`)
      const trace = await runScenario(scenario, {
        provider,
        ctx,
        model: label(ref),
        workspace: 'eval-ws',
        level: 'high',
        // Same arithmetic as contextBudgetFor on the pod: window minus the answer, 85%, capped.
        contextBudgetTokens: Math.min(100000, Math.floor((windowOf(ref) - 4096) * 0.85))
      })
      // Судья идёт вторым слоем: ассерты уже сказали своё, он добирает то, что не формализовать.
      if (judgeCfg !== undefined) {
        trace.judge = { model: judgeCfg.model, verdicts: await judgeTrace(judgeCfg, trace) }
      }
      traces.push(trace)
      const verdict = trace.judge !== undefined ? `  судья ${summarizeVerdicts(trace.judge.verdicts)}` : ''
      if (trace.ok) {
        console.log(`ok   ${Math.round(trace.ms / 1000)}s${verdict}`)
      } else {
        const why =
          trace.error ??
          trace.asserts
            .filter((a) => !a.ok)
            .map((a) => `${a.what}${a.detail !== undefined && a.detail !== '' ? ` (${a.detail})` : ''}`)
            .join('; ')
        console.log(`FAIL ${Math.round(trace.ms / 1000)}s  ${why}${verdict}`)
      }
    }
  }

  const report = renderReport(traces)
  console.log('\n' + report + '\n')
  if (args.report !== undefined && args.report !== '') {
    const fs = await import('fs')
    fs.writeFileSync(args.report, report + '\n')
    fs.writeFileSync(args.report.replace(/\.md$/, '') + '.json', JSON.stringify(traces, null, 2))
    console.log(`Отчёт: ${args.report}`)
  }
  return traces.every((t) => t.ok)
}

// ---------------------------------------------------------------------------- main

async function main (): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  windowOverride = args.window
  const served = await loadAllModels()
  if (served.length === 0) {
    console.error('Ни один источник моделей не доступен. Локальный сервер и GIGACHAT_CREDENTIALS не отвечают.')
    process.exitCode = 1
    return
  }

  if (args.command === 'models') {
    printModels(served)
    console.log('Проверить:  rushx eval check <id>   (или --all)')
    console.log('Прогнать:   rushx eval\n')
    return
  }

  if (args.command === 'check') {
    const targets = args.all
      ? served
      : [await chooseModel(served, args.model, 'Какую модель проверяем?')].filter((m): m is ModelRef => m !== undefined)
    if (targets.length === 0) {
      process.exitCode = 1
      return
    }
    for (const ref of targets) {
      console.log(`\n${label(ref)} (окно ${ref.maxModelLen ?? '?'})`)
      bootstrapEnv(ref.id)
      const ctx = await newCtx()
      const provider = await createProvider(ref, ctx)
      const profile = await checkModel(
        {
          ref,
          provider,
          ctx,
          level: 'high',
          probes: ref.source === 'local' ? localProbes(ENDPOINT, KEY, ref.id) : undefined
        },
        endpointOf(ref)
      )
      printProfile(profile)
      console.log(`  профиль: ${writeProfile(profile)}`)
    }
    return
  }

  if (args.command === 'judge') {
    const ref = await chooseModel(served, args.judge ?? args.model, 'Кого проверяем судьёй?')
    if (ref === undefined || ref.source !== 'local') {
      console.error('Судья должен быть с локального эндпоинта: нужен строгий json-schema.')
      process.exitCode = 1
      return
    }
    const { FIXTURES } = await import('./fixtures')
    const { judgeTrace } = await import('./judge')
    console.log(`\nПроверяю судью ${label(ref)} на ${FIXTURES.length} эталонных трассах\n`)
    let wrong = 0
    for (const fixture of FIXTURES) {
      const verdicts = await judgeTrace({ endpoint: ENDPOINT, key: KEY, model: ref.id }, fixture.trace)
      if (verdicts === undefined) {
        console.log(`  FAIL ${fixture.name}: судья не ответил`)
        wrong++
        continue
      }
      const bad = Object.entries(fixture.expected).filter(([id, want]) => {
        const got = verdicts.find((v) => v.id === id)
        return got === undefined || got.met !== want
      })
      if (bad.length === 0) {
        console.log(`  ok   ${fixture.name}`)
      } else {
        wrong++
        console.log(`  FAIL ${fixture.name}`)
        for (const [id, want] of bad) {
          const got = verdicts.find((v) => v.id === id)
          console.log(
            `         ${id}: ожидалось ${String(want)}, получено ${got === undefined ? 'ничего' : String(got.met)}`
          )
          if (got !== undefined) console.log(`         обоснование: ${got.evidence.slice(0, 120)}`)
        }
      }
    }
    console.log(
      wrong === 0
        ? `\n${label(ref)} годится судьёй.\n`
        : `\n${label(ref)} ошибся на ${wrong} из ${FIXTURES.length} - его вердиктам верить нельзя.\n`
    )
    process.exitCode = wrong === 0 ? 0 : 1
    return
  }

  // Judge first: it decides how the run can be judged at all.
  let judge = await chooseJudge(served, args)
  let judgeProfile: ModelProfile | undefined
  if (judge !== undefined) {
    judgeProfile = await clearModel(judge, args, 'судья')
    if (judgeProfile === undefined || !profileSupports(judgeProfile, 'structuredOutput')) {
      console.log(`${label(judge)} не подтвердил строгий JSON - судьёй поставить нельзя.`)
      console.log('Прогон пойдёт только по детерминированным проверкам.')
      judge = undefined
    }
  }

  const prompt =
    judge !== undefined
      ? `На какой модели гоняем сценарии? Enter - та же, что судья (${label(judge)})`
      : 'На какой модели гоняем сценарии?'
  const target = await chooseModel(served, args.model, prompt, judge)
  if (target === undefined) {
    process.exitCode = 1
    return
  }

  const targetProfile =
    judge !== undefined && target.id === judge.id && target.source === judge.source
      ? judgeProfile
      : await clearModel(target, args, 'под тестом')
  if (targetProfile === undefined) {
    console.error('\nМодель не допущена к прогону.')
    process.exitCode = 1
    return
  }

  const ok = await runScenarios(target, judge, args)
  process.exitCode = ok ? 0 : 1
}

void main().catch((err) => {
  console.error(err?.message ?? err)
  process.exitCode = 1
})
