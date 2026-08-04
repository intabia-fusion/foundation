# ЮляИИ (ai-bot): конфигурация, деплой, масштабирование

Один бинарь `intabiafusion/ai-bot`, роль через `MODE`. Развязка ролей - Kafka-очереди,
роли масштабируются независимо. Устройство и сценарии: `docs/llm.md`.

## Роли (MODE)

`Mode: 'all' | 'queue' | 'client' | 'event-router' | 'llm-router' | 'stt-worker'`
(`config.ts`), дефолт `queue` (= `all`). Switch - `index.ts`.

| MODE | Читает из Kafka | Поднимает | Назначение |
|------|-----------------|-----------|------------|
| `all` (= `queue`) | ai-queue, llm-`<id>`, love, stt | всё + ClisrServer (llm+stt) | Всё в одном поде. Dev / малый прод. |
| `event-router` | ai-queue | - (Kafka->Kafka) | Резолв модели по `event.level`, перекладка в `llm-<id>`. Точка входа для transactor. |
| `llm-router` | llm-`<id>` (свои) | ClisrServer (llm) только если есть clisr-провайдер | Выполняет LLM-запросы. Для clisr-моделей к нему подключаются обработчики. |
| `stt-worker` | stt-queue | ClisrServer (transcription) + Deepgram poll | Транскрибация. Транскрибаторы подключаются как clisr-клиенты. |
| `client` | - | clisr-клиент | Обработчик: коннектится к router/серверу, выполняет LLM/ASR. Опт-ауты `LLM_PROVIDER=none`/`STT_PROVIDER=none` живут тут. |

**stt-ingest вездесущ.** Приём аудио (`/love/send_raw`, `/love/send_session`), placeholder,
постановка в `TranscriptionQueue`, meeting-lifecycle (`LoveQueue`) запускаются в КАЖДОЙ роли
кроме `client` (`startSttIngest`). Stateless и дёшево -> love шлёт аудио на любой под.

**REST API** (`/levels`, `/asr-levels`, `/translate`, `/summarize`, `/love/*`) поднимается
во всех ролях кроме `client`. `GET /levels` / `GET /asr-levels` отдают каталог уровней для
UI-пикера - каталог живёт в поде, не в БД.

## Ключевое ограничение: ClisrServer = состояние пода

clisr-воркер (`MODE=client`) коннектится по WebSocket к ОДНОМУ поду (`SERVER_URL`). Раздача
задач (`requestWithFilter` для LLM, `binaryRequest` для ASR) - round-robin ТОЛЬКО по сессиям
этого пода. Реплики clisr-приёмника друг о друге не знают.

Следствие: под, раздающий задачи через clisr (`stt-worker`, или `llm-router` с
clisr-провайдером), должен быть **1 точкой входа** - иначе воркеры расколются по репликам,
а Kafka-партиция может попасть на реплику без подключённых воркеров -> запрос зависнет.

**Веерная раздача транскрибации требует 1 clisr-приёмник + N воркеров-клиентов.**

## Модель масштабирования

| Механизм | Что даёт | Ограничение |
|----------|----------|-------------|
| `concurrency` (per провайдер, yaml) | Макс ОДНОВРЕМЕННЫХ in-flight на 1 поде (`RateLimiter`) | Не rps: rps ≈ concurrency / avg_latency |
| реплики роли | Kafka consumer-group делит партиции топика | Реплик не больше числа партиций |
| `batch` (per провайдер) | Размер Kafka batch-consumer pull | Буфер, не троттл |
| N воркеров `client` | Горизонтально масштабируют выполнение за 1 clisr-приёмником | Все коннектятся к 1 `SERVER_URL` |

**Нет time-based rps-троттла в коде.** Провайдерский лимит "N/сек" задаётся через
`concurrency` (одновременные) и/или число реплик. Строгий rps не гарантируется - зависит
от латентности провайдера.

### Решение: 1 под на LLM-модель + concurrency

**llm-router - тонкий прокси:** нет CPU/памяти-нагрузки, только проброс провайдеру. Масштаб
репликами не нужен - **1 под на провайдера (модель)**, пропускную даёт `concurrency`
(напр. 10 параллельных). Разные уровни (`serves: low/pro/max`) обслуживает один под.

Топики создаются с 1 партицией (`createTopic(topic, 1)`) - лишние реплики простаивали бы
(1 партиция = 1 активный consumer в группе). Реплики llm-router НЕ нужны.

## Провайдерский concurrency (одновременные запросы)

| Тариф / провайдер | `concurrency` | Комментарий |
|-------------------|---------------|-------------|
| GigaChat персональный | **1** | 1 одновременный запрос |
| GigaChat бизнес | **10** | 10 одновременных |
| clisr (локальные воркеры) | = число воркеров | Раздача веером |
| openai / cloud | по лимиту аккаунта | Обычно высокий |

## Реестр провайдеров (yaml)

Источник - YAML (`CONFIG_PATH` = путь, или `CONFIG_YAML` = base64). `expandEnv` раскрывает
`${VAR:-default}`. Один yaml может держать и `llm:`, и `asr:`.

```yaml
llm:
  defaultLevel: low          # уровень по умолчанию (id из models)
  models:                    # классы уровней (общие для всех провайдеров)
    low:    { order: 0, label: 'Базовый',  tokenMultiplier: 1 }
    pro:    { order: 1, label: 'Стандарт', tokenMultiplier: 2 }
    max:    { order: 2, label: 'Профи',    tokenMultiplier: 4 }
  providers:
    - id: gigachat           # = суффикс топика llm-gigachat
      provider: gigachat     # openai | gigachat | clisr
      concurrency: 1         # персональный тариф. Бизнес -> 10
      batch: 1
      endpointConfig:        # общий auth (один клиент на провайдер)
        credentials: '${GIGACHAT_AUTH_KEY}'
        scope: GIGACHAT_API_PERS
      serves:                # один провайдер -> несколько уровней
        pro: { model: GigaChat-2-Pro }
        max: { model: GigaChat-2-Max }
    - id: clisr
      provider: clisr
      concurrency: 4         # раздаётся clisr-воркерам этого пода
      serves:
        low: { model: local }

asr:                         # зеркалит llm:
  defaultLevel: default
  models:
    default: { order: 0, label: 'Базовый', tokenMultiplier: 1 }  # multiplier за СЕКУНДУ аудио
  providers:
    - id: clisr
      provider: server       # раздаётся clisr-воркерам этого пода
      serves:
        default: { model: default }
    - id: openai
      provider: openai       # прямой openai-совместимый endpoint
      serves:
        premium: { model: whisper-1, url: 'http://...', apiKey: '...' }
```

Валидация: каждый уровень обслуживается ровно одним провайдером (иначе throw).
Если `llm.providers` пуст - реестр синтезируется из legacy env (`LLM_PROVIDER` + `OPENAI_*`
/ `GIGACHAT_*`) как один провайдер уровня `defaultLevel`. Если `asr:` пуст - транскрибация
отключена.

- `AILevel` = свободная строка-id (не enum). UI читает из `GET /levels`, сортирует по
  `order`, показывает `label`/`description`.
- `tokenMultiplier`: `billedTokens = ceil((prompt+completion) * tokenMultiplier)`.
- Уровень запроса = свойство запроса; пространство задаёт потолок (`AISpaceSettings`).
  Server-trigger кладёт активный уровень в `event.level`.

## Переменные окружения

### Общие (все роли кроме client)
| Env | Назначение |
|-----|------------|
| `MODE` | роль, дефолт `queue`=`all` |
| `ACCOUNTS_URL` | account-сервис |
| `SERVER_SECRET` | секрет токенов |
| `SERVICE_ID` | id сервиса (дефолт `ai-bot-service`) |
| `API_TOKEN` | токен авторизации clisr-клиентов |
| `PORT` | порт HTTP/WS (дефолт 4010) |
| `QUEUE_CONFIG` | Kafka/redpanda |
| `STORAGE_CONFIG`, `CHUNK_STORAGE_CONFIG` | хранилище (blob + аудио-чанки). Обязательно (нет неявного MINIO_*) |
| `STATS_URL`, `BILLING_URL`, `LOVE_ENDPOINT` | сервисы |
| `FIRST_NAME`, `LAST_NAME`, `PASSWORD`, `AVATAR_*` | идентичность бота |
| `MAX_CONTENT_TOKENS`, `MAX_HISTORY_RECORDS` | лимиты контекста |
| `CONFIG_PATH` / `CONFIG_YAML` | yaml-реестр (путь / base64) |

### LLM
| Env | Назначение |
|-----|------------|
| `AI_DEFAULT_LEVEL` | уровень по умолчанию (если нет yaml) |
| `LLM_PROVIDER_IDS` | для `llm-router`: csv id провайдеров (пусто = все из реестра) |
| `LLM_PROVIDER` | legacy: `openai`\|`gigachat`\|`clisr` (если нет yaml.providers) |
| `LLM_BATCH` | legacy размер батча |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_SUMMARY_MODEL`, `OPENAI_TRANSLATE_MODEL` | OpenAI |
| `GIGACHAT_CREDENTIALS`, `GIGACHAT_SCOPE`, `GIGACHAT_MODEL`, `GIGACHAT_BASE_URL`, `GIGACHAT_TIMEOUT` | GigaChat |

### ASR
Провайдер/модель - из yaml `asr:` реестра. Legacy `STT_URL`/`STT_API_KEY`/`STT_MODEL`/`stt:`
**УБРАНЫ**.

| Env | Назначение |
|-----|------------|
| `STT_PROVIDER` | опт-аут: `none` = отключить ASR (в client-режиме). Иначе провайдер из реестра |
| `STT_BATCH` | размер батча транскрипции |
| `VAD_RMS_THRESHOLD`, `VAD_SPEECH_RATIO_THRESHOLD` | VAD |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID`, `DEEPGRAM_TAG`, `DEEPGRAM_POLL_INTERVAL_MINUTES` | Deepgram |

### client (обработчик)
| Env | Назначение |
|-----|------------|
| `MODE=client` | обработчик |
| `SERVER_URL` | ws-адрес router/сервера (напр. `ws://aibot:4010`) |
| `API_TOKEN` | должен совпасть с router |
| `CLIENT_ID` | логический id воркера для per-client учёта usage. Пусто = прямой |
| `LLM_PROVIDER=none` / `STT_PROVIDER=none` | опт-аут capability при общем yaml (LLM+ASR в одном реестре) |

## Per-client учёт (экономика воркеров)

`CLIENT_ID` (env или yaml `clientId`) - логический id воркера. Эхом возвращается в
результатах LLM/ASR, роутер атрибутирует usage этому id (admin -> «Использование»). Пусто =
прямой провайдер (без воркера). Задавай уникальный на каждый `client`-под.

## Опт-аут capability на общем конфиге

Один yaml может содержать и `llm:`, и `asr:`. `client`-под поднимает ОБЕ capability по
наличию блока. Для разделения на отдельные поды:
- `LLM_PROVIDER=none` - не регистрировать LLM (ASR-only воркер).
- `STT_PROVIDER=none` - не регистрировать ASR (LLM-only воркер).

## Топологии

### A. Простая (1 серверный под) - dev / малый прод

```
MODE=all (1 реплика)   <- clisr воркеры (client) коннектятся сюда
   ClisrServer:4010     веером раздаёт LLM + ASR
```
```
aibot:            MODE=all, replicas: 1
aibot_client_*:   MODE=client, replicas: N, SERVER_URL=ws://aibot:4010, CLIENT_ID=<уникальный>
```

### B. Раздельная (масштабируемая)

```
UI -> transactor -> [event-router]   ai-queue -> llm-<id> топики
                          |
       +------------------+------------------+
       v                  v                  v
 [llm-router          [llm-router        [stt-worker]
  LLM_PROVIDER_IDS=    LLM_PROVIDER_IDS=   <-clisr- транскрибаторы
  gigachat]            clisr]
                       <-clisr- LLM-обработчики

love -> POST /love/send_raw -> любой под (stt-ingest) -> stt-queue -> [stt-worker]
```

Правила реплик:
- `event-router` - **N реплик** (stateless, Kafka делит ai-queue).
- `stt-worker` - **1 реплика** (clisr-приёмник ASR; веер на воркеры).
- `llm-router` (1 под на провайдера/модель) - **1 реплика**. Тонкий прокси: пропускную
  даёт `concurrency`. Разные уровни - в одном поде через `serves`.
- `llm-router` (clisr-провайдер) - **1 реплика** (clisr-приёмник LLM).
- `client` (воркеры) - **M реплик**, коннектятся к нужному приёмнику по `SERVER_URL`.

## Матрица реплик (шпаргалка)

| Роль | MODE | Реплики | Почему |
|------|------|---------|--------|
| Router (вход) | `event-router` | N | stateless, Kafka делит ai-queue |
| STT-приёмник | `stt-worker` | 1 | ClisrServer, веер ASR на воркеры |
| LLM на модель (gigachat/openai) | `llm-router` + `LLM_PROVIDER_IDS` | 1 | тонкий прокси; `concurrency`=параллельные. Уровни в одном поде |
| LLM clisr | `llm-router` + `LLM_PROVIDER_IDS=clisr` | 1 | ClisrServer, веер LLM на воркеры |
| Воркеры | `client` | M | горизонтально, `SERVER_URL` -> приёмник |
| Всё-в-одном | `all` | 1 | простая топология, 1 clisr-точка |

## docker-compose dev

`dev/docker-compose.yaml`:
- `aibot` `MODE=all` - всё в одном (event-router + llm-router + stt-worker + ingest).
- `aibot_client_llm` `MODE=client` (`SERVER_URL=ws://aibot:4010`, openai) - LLM-обработчик.
- `aibot_client_stt` `MODE=client` (openai stt) - STT-обработчик.
- `transactor.AI_BOT_URL=http://aibot:4010`, `love.AGENTS`, `love-agent.PLATFORM_URL`.

Разделённая топология: заменить `aibot` тремя сервисами `MODE=event-router` /
`MODE=llm-router` (+`LLM_PROVIDER_IDS`) / `MODE=stt-worker`, направить клиентов на нужный
router (`SERVER_URL`).

## Config через YAML / env

Приоритет: YAML (`CONFIG_PATH`/`CONFIG_YAML`) > env. Storage - только явно (`STORAGE_CONFIG`
или `storage.config` в yaml), неявные `MINIO_*` не используются -> без storage под не
стартует.
