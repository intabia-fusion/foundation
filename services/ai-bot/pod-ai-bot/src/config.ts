//
// Copyright © 2024 Hardcore Engineering Inc.
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

import OpenAI from 'openai'
import fs from 'fs'
import yaml from 'js-yaml'

import { SttProviderType } from './transcription/types'

/** Assistant quality level id. Data-driven, not an enum: a free-form string defined in the registry. */
export type AILevel = string

/** Per-feature availability of a level (unset = allowed). Restricts which features a level serves. */
export interface AILevelFeatures {
  talk?: boolean
  chat?: boolean
  summary?: boolean
  tasks?: boolean
}

/** Per-level model binding inside a provider (model + billing + UI metadata). */
export interface AILevelModel {
  model: string // provider-specific model name for this level
  tokenMultiplier: number // billedTokens = (prompt+completion) * tokenMultiplier
  displayMultiplier?: number // UI-facing "xN" relative to the base (middle) level; falls back to tokenMultiplier when unset
  order: number // sort key for UI + fallback ladder (lower = weaker/cheaper)
  label: string // UI label shown to the user
  capabilities?: {
    maxContextTokens?: number
    // Output token cap for a single generation. Set per model/level in the yaml registry so a
    // long rewrite_document body isn't truncated mid-argument. Provider default when unset.
    maxOutputTokens?: number
  }
  // Per-feature availability (unset = allowed); a weak model can be chat-only. Surfaced in /levels.
  features?: AILevelFeatures
}

/** One provider instance: a single client/auth and one queue topic `llm-<id>`, shared across the levels it serves. */
export interface AIProviderConfig {
  id: string // unique id, used as the per-provider topic suffix `llm-<id>`
  provider: 'openai' | 'gigachat' | 'clisr' | 'mock'
  concurrency: number // shared RateLimiter rate for the whole provider
  batch: number // shared batch consumer size for this provider's topic
  levels: Partial<Record<AILevel, AILevelModel>> // which levels this provider serves
  endpoint?: string // shared endpoint override (clisr router url / openai baseUrl)
  endpointConfig?: Record<string, unknown> // shared auth (apiKey, scope, credentials)
}

/** UI/accounting metadata for a quality level class (no concrete model). */
export interface AILevelClass {
  order: number
  label: string
  // false disables the level everywhere (registry, dropdown, routing) without deleting its config —
  // e.g. a provider-side model not yet available on the current plan. Defaults to enabled.
  enabled?: boolean
  tokenMultiplier: number
  displayMultiplier?: number
  // Per-feature availability of this level (unset = allowed). e.g. Базовый -> { talk: false }.
  features?: AILevelFeatures
}

/** New-schema serves entry: string (model name) or object with overrides. */
export type ServesEntry =
  | string
  | {
    model: string
    // false skips this binding: keep several alternative models for a level in the yaml
    // and flip which one is live without deleting config.
    enabled?: boolean
    capabilities?: {
      maxContextTokens?: number
      maxOutputTokens?: number
    }
    // Overrides models[level].features for this binding (a smaller local model may drop tools).
    features?: AILevelFeatures
  }

/** New-schema provider spec (uses `serves` instead of `levels`). */
export interface AIProviderSpec {
  id: string
  provider: 'openai' | 'gigachat' | 'clisr' | 'mock'
  concurrency: number
  batch: number
  enabled?: boolean // false drops the whole provider from the registry
  endpoint?: string
  endpointConfig?: Record<string, unknown>
  serves: Partial<Record<AILevel, ServesEntry>>
}

/** ASR quality level id. Mirrors AILevel: a free-form string defined in the registry. */
export type AsrLevel = string

/** UI/accounting metadata for an ASR quality level class (no concrete model). */
export interface AsrLevelClass {
  order: number
  label: string
  enabled?: boolean
  tokenMultiplier: number // billed factor per SECOND of transcribed audio (not per token)
  displayMultiplier?: number
}

/** ASR serves entry: model name, or object with per-serve url/apiKey overrides. */
export type AsrServesEntry =
  | string
  | {
    model: string
    url?: string
    apiKey?: string
    enabled?: boolean // false skips this binding (keep alternatives in the yaml)
  }

/** ASR provider spec (mirrors AIProviderSpec). */
export interface AsrProviderSpec {
  id: string
  provider: SttProviderType
  enabled?: boolean // false drops the whole provider from the registry
  serves: Partial<Record<AsrLevel, AsrServesEntry>>
}

/** Per-level model binding inside an ASR provider (mirrors AILevelModel). */
export interface AsrLevelModel {
  model: string
  tokenMultiplier: number
  displayMultiplier?: number
  order: number
  label: string
  url?: string
  apiKey?: string
}

/** Resolved ASR provider (mirrors AIProviderConfig). */
export interface AsrProviderConfig {
  id: string
  provider: SttProviderType
  levels: Partial<Record<AsrLevel, AsrLevelModel>>
}

interface Config {
  AccountsURL: string
  ServerSecret: string
  ServiceID: string
  FirstName: string
  LastName: string
  AvatarPath: string
  AvatarName: string
  AvatarContentType: string
  Password: string

  // Pod role selected by MODE. STT ingest + meeting lifecycle run in every role by default
  // (stateless, cheap) so love can post audio to any pod.
  Mode: 'all' | 'queue' | 'client' | 'event-router' | 'llm-router' | 'stt-worker'
  // For 'llm-router': which provider ids this pod serves (empty = all in the registry).
  LLMProviderIds: string[]
  // In client mode we connect to accounts server and wait for requests.
  ServerUrl: string
  ApiToken: string // Api token for clients to handle server in LLMProvider and STT provider 'server' mode.
  // Logical worker id for per-client usage attribution; echoed in every LLM/ASR result. Env: CLIENT_ID.
  ClientId: string

  MaxContentTokens: number
  MaxHistoryRecords: number
  // Compaction thresholds, same defaults pi runs with. Reserve is the room left for the answer;
  // keepRecent is how much of the tail stays verbatim behind the summary.
  CompactionReserveTokens: number
  CompactionKeepRecentTokens: number
  Port: number
  LoveEndpoint: string
  BillingUrl: string

  StorageConfig: string
  ChunkStorage: string // A blob temporal storage, for ogm and wav chunks.

  // If specified all chunks will be saved to this directory, per user at a time.wav + transcription
  DebugDir?: string

  // When true, log full LLM payloads (messages, tool definitions, tool calls,
  // raw completions) for debugging. Verbose; off by default. Env: LLM_DEBUG=true.
  LLMDebug: boolean

  // LLM parameters
  // LLM selection (e.g. 'openai' | 'gigachat' | 'server' or leave empty for auto)
  LLMProvider: string // Could be 'server' to pass LLM requests to connected clients.
  LLMProcessingBatch: number // Batch size for LLM request processing (1 = no batching)

  // Provider registry: every provider the pod can route to. Built from yaml `llm.providers`,
  // or synthesized from the legacy single-provider settings.
  AIProviders: AIProviderConfig[]
  DefaultLevel: AILevel
  // Fallback language for the bot's non-personal replies when a space has none set.
  DefaultLanguage: string

  // ******************
  // Openai
  OpenAIKey: string
  OpenAIModel: OpenAI.ChatModel
  OpenAIBaseUrl: string
  OpenAITranslateModel: OpenAI.ChatModel
  OpenAISummaryModel: OpenAI.ChatModel
  // ******************

  // ******************
  // GigaChat configuration
  GigaChatCredentials: string
  GigaChatScope: string
  GigaChatModel: string
  GigaChatBaseUrl: string
  GigaChatTimeout: string
  GigaChatMaxTokens: number
  // ******************

  DataLabApiKey: string
  // ******************

  // SttProvider is an opt-out switch: 'none' disables ASR even when the yaml `asr:` block is
  // present. Actual provider/model come from AsrProviders. Env: STT_PROVIDER.
  SttProvider: SttProviderType
  SttProcessingBatch: number // If defined will consume messages by bulks and pass to transcriber
  // Chunks the router keeps in flight on this worker. Inert while SttProcessingBatch is 1.
  // Env: STT_CAPACITY, yaml `asr.capacity`.
  SttCapacity: number

  // ASR provider registry (mirrors AIProviders). Built from yaml `asr.models`+`asr.providers`.
  AsrProviders: AsrProviderConfig[]
  AsrDefaultLevel: AsrLevel

  DeepgramPollIntervalMinutes: number
  DeepgramApiKey: string
  DeepgramProjectId: string
  DeepgramTag: string

  // VAD settings
  VadRmsThreshold: number
  VadSpeechRatioThreshold: number
}

// Define the YAML configuration structure
interface YamlConfig {
  accounts: {
    url: string
    serverSecret: string
    serviceId?: string
  }
  bot: {
    firstName: string
    lastName: string
    password?: string
    avatar?: {
      path?: string
      name?: string
      contentType?: string
    }
  }
  port?: number
  clientId?: string // logical worker id for per-client usage attribution
  llm: {
    provider?: string
    batch?: number
    defaultLevel?: AILevel
    models?: Partial<Record<AILevel, AILevelClass>>
    providers?: AIProviderSpec[]
    openai?: {
      apiKey?: string
      model?: string
      baseUrl?: string
      translateModel?: string
      summaryModel?: string
    }
    gigachat?: {
      credentials?: string
      scope?: string
      model?: string
      baseUrl?: string
      timeout?: string
    }
  }
  // ASR registry, mirrors `llm`. Absent -> transcription disabled for this pod.
  asr?: {
    defaultLevel?: AsrLevel
    batch?: number
    capacity?: number
    models?: Partial<Record<AsrLevel, AsrLevelClass>>
    providers?: AsrProviderSpec[]
  }
  deepgram?: {
    apiKey?: string
    projectId?: string
    tag?: string
    pollIntervalMinutes?: number
  }
  vad?: {
    rmsThreshold?: number
    speechRatioThreshold?: number
  }
  services: {
    love: {
      endpoint: string
    }
    billing: {
      url: string
    }
    datalab?: {
      apiKey?: string
    }
  }
  storage?: {
    config?: string
    chunks?: string
  }
  limits?: {
    maxContentTokens?: number
    compactionReserveTokens?: number
    compactionKeepRecentTokens?: number
    maxHistoryRecords?: number
  }
  debug?: {
    dir?: string
  }
}

// A non-numeric env value falls through to the caller's default instead of poisoning it with NaN.
const parseNumber = (str: string | undefined): number | undefined => {
  if (str === undefined) {
    return undefined
  }
  const value = Number(str)
  return Number.isFinite(value) ? value : undefined
}

/** Merge new-schema (models+serves) entries into the legacy AIProviderConfig shape. */
const resolveProviderSpec = (
  spec: AIProviderSpec,
  models: Partial<Record<AILevel, AILevelClass>> | undefined
): AIProviderConfig => {
  const levels: Partial<Record<AILevel, AILevelModel>> = {}
  for (const [level, entry] of Object.entries(spec.serves)) {
    if (entry === undefined) continue
    const cls = models?.[level]
    if (cls === undefined) {
      console.warn(`[config] models.${level} not defined; skipping serves entry for provider ${spec.id}`)
      continue
    }
    if (cls.enabled === false) {
      // Level explicitly disabled in config: skip so it never enters the registry/routing.
      continue
    }
    const model = typeof entry === 'string' ? entry : entry.model
    const overrides = typeof entry === 'string' ? undefined : entry
    if (overrides?.enabled === false) continue
    levels[level] = {
      model,
      tokenMultiplier: cls.tokenMultiplier,
      displayMultiplier: cls.displayMultiplier,
      order: cls.order,
      label: cls.label,
      features: overrides?.features ?? cls.features,
      capabilities: overrides?.capabilities
    }
  }
  return {
    id: spec.id,
    provider: spec.provider,
    concurrency: spec.concurrency,
    batch: spec.batch,
    endpoint: spec.endpoint,
    endpointConfig: spec.endpointConfig,
    levels
  }
}

/**
 * Each level must be served by exactly one provider: ambiguous routing would pick the first
 * provider in yaml order and silently mis-bill.
 */
const assertUniqueLevelOwner = (
  registry: Array<{ id: string, levels: Partial<Record<string, unknown>> }>,
  kind: 'AI' | 'ASR'
): void => {
  const owner = new Map<string, string>()
  for (const provider of registry) {
    for (const level of Object.keys(provider.levels)) {
      if (provider.levels[level] === undefined) continue
      const prev = owner.get(level)
      if (prev !== undefined) {
        throw new Error(
          `${kind} config error: level '${level}' is served by both '${prev}' and '${provider.id}'. Each level must be served by exactly one provider` +
            (kind === 'AI' ? ' (use enabled: false to park an alternative).' : '.')
        )
      }
      owner.set(level, provider.id)
    }
  }
}

/**
 * Builds the provider registry from yaml `llm.models`+`llm.providers[].serves`, or synthesizes
 * a single legacy-env provider when no yaml providers are given.
 */
const buildProviderRegistry = (yamlConfig: YamlConfig | null): AIProviderConfig[] => {
  const explicit = yamlConfig?.llm?.providers?.filter((p) => p.enabled !== false)
  if (explicit !== undefined && explicit.length > 0) {
    const models = yamlConfig?.llm?.models
    const registry = explicit.map((spec) => resolveProviderSpec(spec, models))
    assertUniqueLevelOwner(registry, 'AI')
    return registry
  }

  const provider = (yamlConfig?.llm?.provider ?? process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase()
  const batch = yamlConfig?.llm?.batch ?? parseInt(process.env.LLM_BATCH ?? '1')
  const level = yamlConfig?.llm?.defaultLevel ?? process.env.AI_DEFAULT_LEVEL ?? 'low'

  if (provider === 'gigachat') {
    const model = yamlConfig?.llm?.gigachat?.model ?? process.env.GIGACHAT_MODEL ?? 'GigaChat'
    return [
      {
        id: 'gigachat',
        provider: 'gigachat',
        concurrency: 1,
        batch,
        levels: {
          [level]: {
            model,
            tokenMultiplier: 1,
            order: 0,
            label: 'GigaChat'
          }
        }
      }
    ]
  }

  const isClisr = provider === 'server' || provider === 'clisr'
  const model = yamlConfig?.llm?.openai?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  return [
    {
      id: isClisr ? 'clisr' : 'openai',
      provider: isClisr ? 'clisr' : 'openai',
      concurrency: isClisr ? 4 : 8,
      batch,
      levels: {
        [level]: {
          model,
          tokenMultiplier: isClisr ? 2 : 1,
          order: 0,
          label: isClisr ? 'Local' : 'Standard',
          capabilities: { maxContextTokens: 128 * 1024 }
        }
      }
    }
  ]
}

/** Merge new-schema (models+serves) entries into the AsrProviderConfig shape. */
const resolveAsrProviderSpec = (
  spec: AsrProviderSpec,
  models: Partial<Record<AsrLevel, AsrLevelClass>> | undefined
): AsrProviderConfig => {
  const levels: Partial<Record<AsrLevel, AsrLevelModel>> = {}
  for (const [level, entry] of Object.entries(spec.serves)) {
    if (entry === undefined) continue
    const cls = models?.[level]
    if (cls === undefined) {
      console.warn(`[config] asr.models.${level} not defined; skipping serves entry for provider ${spec.id}`)
      continue
    }
    if (cls.enabled === false) continue
    const model = typeof entry === 'string' ? entry : entry.model
    const overrides = typeof entry === 'string' ? undefined : entry
    if (overrides?.enabled === false) continue
    levels[level] = {
      model,
      tokenMultiplier: cls.tokenMultiplier,
      displayMultiplier: cls.displayMultiplier,
      order: cls.order,
      label: cls.label,
      url: overrides?.url,
      apiKey: overrides?.apiKey
    }
  }
  return { id: spec.id, provider: spec.provider, levels }
}

/** Builds the ASR provider registry from yaml `asr.models`+`asr.providers`; empty when absent. */
const buildAsrRegistry = (yamlConfig: YamlConfig | null): AsrProviderConfig[] => {
  const explicit = yamlConfig?.asr?.providers?.filter((p) => p.enabled !== false)
  if (explicit !== undefined && explicit.length > 0) {
    const models = yamlConfig?.asr?.models
    const registry = explicit.map((spec) => resolveAsrProviderSpec(spec, models))
    assertUniqueLevelOwner(registry, 'ASR')
    return registry
  }

  // No `asr:` block -> transcription disabled for this pod.
  return []
}

// Expand ${VAR} / ${VAR:-default} placeholders in the yaml text from process.env so
// secrets (e.g. GIGACHAT_AUTH_KEY) can live in the environment, not in the file.
export const expandEnv = (text: string): string =>
  text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => {
    const v = process.env[name]
    return v !== undefined && v !== '' ? v : (def ?? '')
  })

const config: Config = (() => {
  // Try to load configuration from YAML file first
  let yamlConfig: YamlConfig | null = null

  // Check if CONFIG_PATH environment variable is set
  const configPath = process.env.CONFIG_PATH
  if (configPath !== undefined && fs.existsSync(configPath)) {
    try {
      const configFileContent = fs.readFileSync(configPath, 'utf8')
      yamlConfig = yaml.load(expandEnv(configFileContent)) as YamlConfig
    } catch (error) {
      console.warn(`Failed to load YAML config from ${configPath}:`, error)
    }
  }

  // Also check if CONFIG_YAML environment variable is set (with base64 encoded content)
  const configYaml = process.env.CONFIG_YAML
  if (configYaml !== undefined) {
    try {
      const decodedYaml = Buffer.from(configYaml, 'base64').toString('utf8')
      yamlConfig = yaml.load(expandEnv(decodedYaml)) as YamlConfig
    } catch (error) {
      console.warn('Failed to load YAML config from CONFIG_YAML environment variable:', error)
    }
  }

  // Legacy `stt:` block is silently ignored (replaced by `asr:`) — warn so deploys still on
  // the old key notice ASR stopped working instead of losing it quietly.
  if ((yamlConfig as any)?.stt !== undefined) {
    console.warn('[config] yaml `stt:` block is deprecated and ignored; migrate to `asr:`')
  }

  // Build the config object, prioritizing YAML config over environment variables
  const params: Partial<Config> = {
    // Accounts configuration
    AccountsURL: yamlConfig?.accounts?.url ?? process.env.ACCOUNTS_URL,
    ServerSecret: yamlConfig?.accounts?.serverSecret ?? process.env.SERVER_SECRET,
    ServiceID: yamlConfig?.accounts?.serviceId ?? process.env.SERVICE_ID ?? 'ai-bot-service',

    Mode: (process.env.MODE ?? 'queue') as Config['Mode'],
    LLMProviderIds: (process.env.LLM_PROVIDER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    ServerUrl: process.env.SERVER_URL ?? '',
    ApiToken: process.env.API_TOKEN ?? '',
    ClientId: yamlConfig?.clientId ?? process.env.CLIENT_ID ?? '',

    // Bot identity configuration
    FirstName: yamlConfig?.bot?.firstName ?? process.env.FIRST_NAME,
    LastName: yamlConfig?.bot?.lastName ?? process.env.LAST_NAME,
    Password: yamlConfig?.bot?.password ?? process.env.PASSWORD ?? 'password',
    AvatarPath: yamlConfig?.bot?.avatar?.path ?? process.env.AVATAR_PATH ?? './assets/avatar.png',
    AvatarName: yamlConfig?.bot?.avatar?.name ?? process.env.AVATAR_NAME ?? 'ai_bot_avatar_v1',
    AvatarContentType: yamlConfig?.bot?.avatar?.contentType ?? process.env.AVATAR_CONTENT_TYPE ?? 'image/png',

    // Port configuration
    Port: yamlConfig?.port ?? parseNumber(process.env.PORT) ?? 4010,

    // LLM configuration
    LLMProvider: yamlConfig?.llm?.provider ?? process.env.LLM_PROVIDER ?? '',
    LLMProcessingBatch: yamlConfig?.llm?.batch ?? parseInt(process.env.LLM_BATCH ?? '1'),
    OpenAIKey: yamlConfig?.llm?.openai?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
    OpenAIModel: (yamlConfig?.llm?.openai?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini') as OpenAI.ChatModel,
    OpenAIBaseUrl: yamlConfig?.llm?.openai?.baseUrl ?? process.env.OPENAI_BASE_URL ?? '',
    OpenAITranslateModel: (yamlConfig?.llm?.openai?.translateModel ??
      process.env.OPENAI_TRANSLATE_MODEL ??
      process.env.OPENAI_MODEL ??
      'gpt-4o-mini') as OpenAI.ChatModel,
    OpenAISummaryModel: (yamlConfig?.llm?.openai?.summaryModel ??
      process.env.OPENAI_SUMMARY_MODEL ??
      process.env.OPENAI_MODEL ??
      'gpt-4o-mini') as OpenAI.ChatModel,

    // GigaChat configuration
    GigaChatCredentials: yamlConfig?.llm?.gigachat?.credentials ?? process.env.GIGACHAT_CREDENTIALS ?? '',
    GigaChatScope: yamlConfig?.llm?.gigachat?.scope ?? process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS',
    GigaChatModel: yamlConfig?.llm?.gigachat?.model ?? process.env.GIGACHAT_MODEL ?? 'GigaChat',
    GigaChatBaseUrl:
      yamlConfig?.llm?.gigachat?.baseUrl ??
      process.env.GIGACHAT_BASE_URL ??
      'https://gigachat.devices.sberbank.ru/api/v1/',
    GigaChatTimeout: yamlConfig?.llm?.gigachat?.timeout ?? process.env.GIGACHAT_TIMEOUT ?? '600',
    GigaChatMaxTokens: Number((yamlConfig?.llm?.gigachat as any)?.maxTokens ?? process.env.GIGACHAT_MAX_TOKENS ?? 8192),

    AIProviders: buildProviderRegistry(yamlConfig),
    DefaultLevel: yamlConfig?.llm?.defaultLevel ?? process.env.AI_DEFAULT_LEVEL ?? 'low',
    DefaultLanguage: process.env.AI_DEFAULT_LANGUAGE ?? 'ru',

    // Limits
    MaxContentTokens: yamlConfig?.limits?.maxContentTokens ?? parseNumber(process.env.MAX_CONTENT_TOKENS) ?? 128 * 100,
    MaxHistoryRecords: yamlConfig?.limits?.maxHistoryRecords ?? parseNumber(process.env.MAX_HISTORY_RECORDS) ?? 500,
    CompactionReserveTokens:
      yamlConfig?.limits?.compactionReserveTokens ?? parseNumber(process.env.COMPACTION_RESERVE_TOKENS) ?? 16384,
    CompactionKeepRecentTokens:
      yamlConfig?.limits?.compactionKeepRecentTokens ?? parseNumber(process.env.COMPACTION_KEEP_RECENT_TOKENS) ?? 20000,

    // Service endpoints
    LoveEndpoint: yamlConfig?.services?.love?.endpoint ?? process.env.LOVE_ENDPOINT ?? '',
    DataLabApiKey: yamlConfig?.services?.datalab?.apiKey ?? process.env.DATALAB_API_KEY ?? '',
    BillingUrl: yamlConfig?.services?.billing?.url ?? process.env.BILLING_URL ?? '',

    // Deepgram configuration
    DeepgramPollIntervalMinutes:
      yamlConfig?.deepgram?.pollIntervalMinutes ?? parseNumber(process.env.DEEPGRAM_POLL_INTERVAL_MINUTES) ?? 60,
    DeepgramApiKey: yamlConfig?.deepgram?.apiKey ?? process.env.DEEPGRAM_API_KEY ?? '',
    DeepgramProjectId: yamlConfig?.deepgram?.projectId ?? process.env.DEEPGRAM_PROJECT_ID ?? '',
    DeepgramTag: yamlConfig?.deepgram?.tag ?? process.env.DEEPGRAM_TAG ?? '',

    // ASR opt-out switch ('none' disables) + batch. Provider/model come from AsrProviders.
    SttProvider: (process.env.STT_PROVIDER ?? '') as SttProviderType,
    SttProcessingBatch: yamlConfig?.asr?.batch ?? parseInt(process.env.STT_BATCH ?? '1'),
    SttCapacity: yamlConfig?.asr?.capacity ?? parseNumber(process.env.STT_CAPACITY) ?? 4,

    AsrProviders: buildAsrRegistry(yamlConfig),
    AsrDefaultLevel: yamlConfig?.asr?.defaultLevel ?? 'default',

    // VAD configuration
    VadRmsThreshold: yamlConfig?.vad?.rmsThreshold ?? parseFloat(process.env.VAD_RMS_THRESHOLD ?? '0.02'),
    VadSpeechRatioThreshold:
      yamlConfig?.vad?.speechRatioThreshold ?? parseFloat(process.env.VAD_SPEECH_RATIO_THRESHOLD ?? '0.1'),

    // Storage configuration
    StorageConfig: yamlConfig?.storage?.config ?? process.env.STORAGE_CONFIG ?? undefined,

    // Chunk storage configuration
    ChunkStorage: yamlConfig?.storage?.chunks ?? process.env.CHUNK_STORAGE_CONFIG ?? undefined,

    // Debug configuration
    DebugDir: yamlConfig?.debug?.dir ?? process.env.DEBUG_DIR ?? '',
    LLMDebug: (process.env.LLM_DEBUG ?? 'false').toLowerCase() === 'true'
  }

  // 'client' is a thin clisr worker (only needs the server endpoint); every other
  // role talks to accounts/queues and needs the full config.
  const keys =
    params.Mode === 'client'
      ? (['ServerUrl', 'ApiToken'] as Array<keyof Config>)
      : (Object.keys(params) as Array<keyof Config>)
  const missingEnv = keys.filter((key) => params[key] === undefined)

  if (missingEnv.length > 0) {
    throw Error(
      `Missing config values: ${missingEnv.join(', ')}. Values can be provided via YAML config file or environment variables.`
    )
  }

  return params as Config
})()

export default config
