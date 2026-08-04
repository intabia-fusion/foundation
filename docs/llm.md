# ЮляИИ (ai-bot): устройство и сценарии

Что делает `services/ai-bot/pod-ai-bot` и как обрабатывает LLM/ASR-запросы.
Деплой (роли `MODE`, env, реестр провайдеров, масштабирование): `docs/aibot-deployment.md`.
Backlog и отброшенные решения: `foundation-tasks/` (индекс там).

## Точки входа

| Вход | Где | Что |
|---|---|---|
| Kafka `QueueTopic.AIQueue` | `src/queue.ts` | `AIEventRequest` от платформы (event-router) |
| Kafka `llm-<providerId>` | `src/queue.ts` | запрос, отроутенный на провайдера (llm-router) |
| Kafka `QueueTopic.LoveQueue` | `src/queue.ts` | start/finish митингов (stt-ingest) |
| Kafka `QueueTopic.TranscriptionQueue` | `src/transcription/consumer.ts` | аудио-чанки для ASR (stt-worker) |
| REST (`server/server.ts`) | `/events`, `/translate`, `/summarize`, `/levels`, `/asr-levels`, `/love/*` | прямые операции |

REST-эндпоинты и `stt-ingest` (приём аудио + meeting-lifecycle) поднимаются во всех
ролях кроме `client` - см. деплой-доку.

## Цепочка обработки сообщения

```
AIQueue -> event-router: resolveModel(event.level) -> топик llm-<providerId>
  -> llm-router: batch consumer, RateLimiter(concurrency)
       -> AIControl.processEvent (controller.ts)        # пул провайдера, fallback уровня
       -> WorkspaceClient.processMessageEvent           # контекст, промпты, лимиты
            -> getWorkspaceWindows + decideLevel         # месячное окно (billing)
            -> generateAndReply -> createChatCompletionWithTools  # toolLoop при tool calls
            -> billUsage -> AIRequest(done) -> ChatMessage/ThreadMessage
```

Уровень (`AILevel`) кладёт в событие server-trigger (`applyLevel`), под читает готовый
`event.level`. Роутинг уровня на провайдера - реестр из yaml (`modelRegistry.ts`),
1 провайдер = N уровней.

## Сценарии (что уже работает)

### 1. Чат с ЮляИИ в Direct

Пишешь top-level сообщение в личный Direct с ботом -> бот отвечает **inline** в том же
Direct (не тредом). Ответы в треде под сообщением = продолжение того же разговора
(бот отвечает `ThreadMessage`). Форма ответа определяется классом входящего сообщения
(`writeReply`, `workspaceClient.ts:997`): `ChatMessage` -> inline, `ThreadMessage` -> в тред.

Вход: `server-plugins/ai-bot-resources/src/index.ts` `OnMessageSend` -> direct-ветка ->
producer `AIQueue`. Контекст top-level ответа = сообщения **текущего дня** (`dayLimited`
при `event.objectIdIsSpace`, `workspaceClient.ts:712`), старше - по запросу через тул
`load_thread_history`. Ответ в треде держит полный контекст треда.

### 2. @mention ЮляИИ в каналах/тредах

`@ЮляИИ` в любом канале/треде -> бот отвечает в том же месте. Тот же поток, ветка
по классу родителя.

### 3. Память (sharedPrompt / personalContext)

Бот помнит факты между разговорами. Хранение - `Preference` (`TAIPersonalData`),
источник истины (`workspace/memory.ts` `resolveMemory`); legacy-blob мигрируется в
Preference при чтении. `sharedPrompt` - из `AISpaceSettings`, `personalContext` - из
Preference. **Память всегда кладётся в системный промпт** (`generateAndReply` зовёт
`getMemory` безусловно); get/clear/update-тулов нет - правка через настройки.

### 4. Транскрибация встреч (love)

Говоришь на встрече -> в minutes placeholder, затем текст. `stt-ingest` принимает audio
на любом поде (`/love/send_raw`), кладёт чанк + placeholder -> producer `Transcription`;
`stt-worker` consumer -> ASR -> текст в minutes. Уровень ASR - потолок пространства
(`AISpaceSettings.asrLevel`, `transcriptions.ts` `resolveProvider`, кэш провайдера per-level).

### 5. Саммари встречи / переписки

`/summarize` -> `controller.summarizeMessages` -> выборка chunter + резолв имён ->
`llm.summarizeMessages` -> коллаборативный документ.

### 6. Перевод

`/translate` -> `controller.translate`: markup -> HTML -> `llm.translateHtml` -> markup.

### 7. Выбор уровня ЮляИИ (AILevel)

Уровень = свойство запроса; пространство задаёт потолок (`AISpaceSettings`). Каталог -
`GET /levels` (`availableLevels`, сортировка по order, дедуп). ASR-каталог - `GET /asr-levels`.

### 8. Инструменты модели (tool calling)

Модель в toolLoop вызывает зарегистрированные тулы (`utils/tools.ts` `registerTool`):
`load_thread_history` (подгрузка старых сообщений), `rewrite_document` (в треде),
`getDataBeforeImport` / `saveFile` (только при `DATALAB_API_KEY`). `getTools` фильтрует по
контексту (direct/thread).

## Провайдеры (`src/llms/`)

Все реализуют `LLMProvider` (`src/llms/types.ts`); фабрика `createProvider` (`index.ts:48`):

| Провайдер | Файл | Tool calls | countTokens |
|---|---|---|---|
| `OpenAIProvider` | `openai.ts` | нативные | tiktoken по модели |
| `GigaChatProvider` | `gigachat.ts` | inline (`inlineToolCalls.ts`) | tiktoken `gpt-4` (приближение) |
| `ServerLLMProvider` (clisr) | `server.ts` | через `toolLoop.ts` на поде | `chars / 4` (грубо) |
| `MockProvider` | `mock.ts` | да | фиксированный usage (тесты) |

Streaming нет ни у одного.

## Учёт токенов

`usage` из ответа API; `billedTokens = ceil((prompt + completion) * multiplier)`,
multiplier зависит от уровня и плана (`planMultiplier`: free/paid/с пакетом).
В billing уходит разбивка prompt/completion + `providerId`/`model`/`level` + `clientId`
воркера (`billing.ts` `billUsage`). ASR: `pushTranscriptUsageRecord` шлёт
`durationSeconds` + `providerId`/`model`/`level`/`clientId`. `clientId` - эхо от воркера
(см. per-client учёт в деплой-доке), пусто = прямой провайдер.

## Лимиты

Одно месячное окно billed-токенов `[periodStart, +30d]`, лимит из `Subscription.limits`.
`decideLevel` (`workspace/windowLimit.ts`): под лимитом - как запрошено; сверх лимита -
paid даунгрейдит на `fallbackEligible`-уровень (clisr), free блокируется с сообщением
в Direct. Окно кэшируется на поде 30с, инвалидация по `LimitsChanged`.

## AIRequest - статус-документ запроса

Видимый объект жизненного цикла (`workspace/aiRequest.ts`, домен `DOMAIN_AI`):
processing -> done (prompt/completion/billed токены) либо failed (error). Основа биллинга.

## Масштабирование (кратко)

Координация реплик - только через Kafka (БД за pg-bouncer, advisory locks нельзя).
Роли через `MODE` (`event-router` / `llm-router` / `stt-worker` / `all` / `client`).
Партиционирование по workspace: один workspace обслуживает один consumer -> pod-local
кеши безопасны. clisr - провайдер в реестре наравне с openai/gigachat: обработчики
(локальные модели, транскрибаторы) подключаются clisr-клиентами к поду с `ClisrServer`,
роутинг по capability (`llm` / `transcription`) + round-robin. Детали, реплики, лимиты
провайдеров - `docs/aibot-deployment.md`.

## Тесты

`src/__tests__/` (19 файлов): роутинг (`queue-client-modes`, `e2e-clisr-router`), контекст
(`thread-context`), память (`memory`), реестр (`model-registry`, `asr-registry`), биллинг
(`billing-tokens`, `usage`, `window-limit`, `limits`), провайдеры (`server-provider`,
`e2e-provider`, `e2e-tools`, `inline-tool-calls`, `tool-loop`), запрос (`ai-request`),
компоненты (`components`, `pipeline`, `prompt-store`).

E2e против локального LLM (скип без `AI_BOT_E2E=1`):

```bash
cd services/ai-bot/pod-ai-bot
AI_BOT_E2E=1 AI_BOT_E2E_URL=http://127.0.0.1:8000/v1 AI_BOT_E2E_KEY=1234 \
  AI_BOT_E2E_MODEL=GigaChat3.1-10B-A1.8B-MLX-oQ4 npx jest e2e
```
