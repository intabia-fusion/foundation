# pod-webhook: приём + consumer

TSK-2026-09-01-009..014,021,022,054,056 (приём) + TSK-015..019,020,050,053 (consumer). Каркас+приём
и consumer оба реализованы в `services/webhook/pod-webhook`.

## Ручки

- `POST /api/v1/webhook/action` — ключ в `Authorization: Bearer fus_...`
- `POST /api/v1/webhook/k/:key` — тот же ключ в пути
- `GET /api/v1/webhook/job/:id` — статус (всегда `queued`, consumer его не двигает)
- воркспейса в пути нет: его отдаёт `accountClient.verifyApiKey` (`check.workspace`)
- `GET /health` — без авторизации

Порядок проверок в коде: ключ(401) -> **валидность тела/action(400, добавлено сверх ТЗ — без него
нечем проверять право)** -> право(403) -> лимит(429) -> идемпотентность -> 202. Размер тела (413)
enforced раньше всего этого — `express.json({ limit: '1mb' })` кидает ошибку до захода в хендлер,
так и должно быть (защита от неаутентифицированного DoS телом).

## Где что лежит

- Коды ошибок — один каталог в `src/errors.ts` (`{error: code, message}`, Slack-style).
- `WebhookJobMessage` (сообщение в `QueueTopic.Webhook`) — в `src/types.ts` пода, НЕ в
  `server-core`: агенту было запрещено трогать что-либо в `foundations/server/packages/core` кроме
  `queue/types.ts`. Если consumer нужен в другом поде — тип придётся продублировать или вынести.
  Несёт `spaces: Ref<Space>[]` из `ApiKeyCheck`, чтобы consumer не делал повторный `verifyApiKey`.
- `check.spaces` НЕ сверяется с `body.space` в HTTP-хендлере — `space` в теле это id
  проекта/канала на стороне отправителя, а не `Ref<Space>`. Резолвить и сверять со `spaces` — работа
  consumer'а.

## ponytail-ограничения (искать при добавлении второй реплики)

`src/store.ts` (`WebhookStore`) держит и идемпотентность (`Idempotency-Key`, TTL ~сутки), и статус
задания (`queued`/`done`/`failed`, + `result`/`error`) — в памяти процесса, lazy sweep по TTL. Один
под — ок; несколько реплик за одним LB требуют общий кэш (Redis) вместо этого модуля. Тот же
единственный-под факт означает: если consumer и HTTP-ручка окажутся в разных подах, `GET /job/:id`
не увидит статус, который выставил consumer — сейчас main.ts создаёт один `WebhookStore` и передаёт
его и в `createServer`, и в `startConsumer`.

## Consumer (TSK-015..020,050,053)

- `src/operations.ts` — реестр: `Record<ApiKeyOperation, WebhookExecutor>`, обычный объект, без
  фабрик/интерфейсов. Каждый executor: `(client, payload) => Promise<{space, commit}>` — сперва
  РЕЗОЛВИТ ссылки из тела (бросает `Error('field "<name>": ...')` с именем поля) и возвращает
  `space: Ref<Space>` для проверки прав, отдельно `commit(uploadMarkup)` — реальный вызов `ops.ts`.
  Разделение resolve/commit нужно, чтобы `spaces`-проверка встала МЕЖДУ резолвом и записью (иначе
  можно успеть create/post до проверки права на пространство).
  `isKnownOperation()` из этого же файла — HTTP-ручка (`src/server.ts`) проверяет `action` по нему
  же, а не по `apiKeyOperations` из account-client, чтобы факт "что валидно" и "что исполнимо" не
  расходились.
- Резолв (TSK-050): проект — `findOne(tracker.class.Project, {identifier})`; задача — `findOne(...,
  {identifier})` (используется и для `issue:update`/`issue:comment` — `body.space` в них это
  идентификатор ЗАДАЧИ, не проекта, а `Ref<Space>` для проверки берётся из `issue.space`); канал —
  готовый `resolveChannel` из `@hcengineering/chunter`; исполнитель — `contact.class.SocialIdentity`
  по `{type: SocialIdType.EMAIL, value}` → `.attachedTo`; статус (`issue:update`) — по имени
  case-insensitive среди статусов task-типа проекта (та же схема, что приватный `resolveTaskType` в
  `plugins/tracker/src/ops.ts`, только продублирована — она не экспортирована).
  `doc:create`/`doc:update` — teamspace резолвится по имени (аналог `resolveChannel`), а вот
  `parent`-документ и сам обновляемый `doc:update`-документ берутся как СЫРОЙ `Ref<Document>` —
  ponytail, у документов нет человеческого идентификатора вроде `FUSIO-42`; если понадобится —
  резолв по title в пределах teamspace.
- Markdown → Markup: `issue:comment`/`chat:post`'s `message` идёт ИНЛАЙН в `ops.ts` (не через
  collaborator), поэтому конвертится на входе в consumer: `jsonToMarkup(markdownToMarkup(text))`.
  Для `description`/`content` (коллаборативные поля) конвертация НЕ нужна — сырой markdown-текст
  просто прокидывается как `Markup` (это `type Markup = string`, приведения не требует) и уходит в
  `uploadMarkup(collabId, text)`, а формат `'markdown'` там указывается явно.
- Транспорт в воркспейс — REST, НЕ WebSocket (правка по ходу сессии: изначально был написан вариант
  через `createRestTxOperations`+`createMarkupOperations` из `@hcengineering/api-client`, что заводит
  ДВА REST-клиента; переделано на один). `src/workspaceClient.ts`: `createRestClient(...)` даёт
  `RestClient` (обычный HTTP, `uploadMarkup` есть прямо на нём — отдельный коллаборатор-клиент не
  нужен); поверх — маленький `RestClientAdapter implements Client` (в поде, не в `api-client`),
  синхронные `getHierarchy()/getModel()` отдают модель, загруженную ОДИН раз через `rest.getModel(true)`
  и закэшированную на воркспейс на время жизни пода. `TxOperations` строится заново на каждый вызов
  поверх общего адаптера — дёшево (просто меняет `user`), сеть не трогает. Автор транзакций —
  `ApiKeyCheck.socialId`/`WebhookJobMessage.socialId`, а НЕ токен: под подключается своим сервисным
  токеном (`generateToken(systemAccountUuid, workspace, {service:'webhook'})` →
  `accountClient.selectWorkspace('', 'internal')`), `TxOperations`'у socialId подставляется вторым
  аргументом конструктора.
- Повторы (TSK-020) — через time-machine, сообщение `{type:'schedule', id: jobId, targetDate, topic:
  QueueTopic.Webhook, data: nextJob}` в `QueueTopic.Webhook` НЕ создаётся подом (это чужой топик —
  `services/worker`, он же time-machine, сейчас `enabled: false` в проде, см.
  `foundation-tasks/docs/infra/2026-08-29-201-time-machine-deploy.md`). Backoff 30с/1м/2м/4м/8м,
  5 попыток, потом dead-letter в `failed`. Если продюсер в `QueueTopic.TimeMachine` падает (топика
  нет/брокер недоступен) — job сразу `failed` с причиной, а не висит в `queued` навечно
  (`// ponytail:` в `src/consumer.ts`). **Обновлено (FUSIO-1151):** 4xx от транзактора (bad payload,
  forbidden) теперь фейлится сразу, без похода в backoff-расписание — см. раздел ниже.
- Чего не хватило в `ops`: ничего, все 6 операций легли на существующие `createIssue`/`updateIssue`/
  `commentIssue`/`postMessage`/`resolveChannel`/`createDocument`/`updateDocument` без обходных путей.

## Прочее

- Сервисный токен: `generateToken(systemAccountUuid, undefined, { service: 'webhook' })`,
  `accountClient.verifyApiKey` ходит с ним.
- Rate limit — `SlidingWindowRateLimitter` из `@hcengineering/rpc`, два независимых счётчика
  (per-keyId, per-source-IP), общий `RateLimitMax`/`RateLimitWindowMs` из конфига. Заголовки 429 —
  ровно формат `rateLimitToHeaders` из `pods/server/src/rpc.ts`.
- QueueTopic добавлены в `foundations/server/packages/core/src/queue/types.ts`: `Webhook` (входящие,
  используется) и `WebhookDelivery` (исходящие, зарезервирован, топик пока нигде не создаётся).
- Никакого morgan/access-log в этом поде специально — путь `/k/:key` содержит ключ в URL, обычный
  request-логгер утёк бы его в логи. Логируем вручную только `keyId` (после verifyApiKey), никогда
  сырой ключ.

## Исполнение операций переехало в транзактор (FUSIO-1151)

Под больше не держит модель воркспейса и не строит `TxOperations` — только аутентифицирует ключ,
лимитирует, кладёт в очередь; consumer шлёт HTTP в транзактор.

- `pods/server/src/opsApi.ts` — реестр `Record<ApiKeyOperation, OpsExecutor>`, перенесённый почти
  один в один из бывшего `src/operations.ts` пода (резолв project/issue/assignee/status/teamspace/
  document). Разница: `WebhookResolved{space, commit}` схлопнута в один `(client, payload) =>
  Promise<Record<string,unknown>>` — ручной `spaces`-гейт между resolve/commit убран, эту проверку
  теперь на каждый tx делает `ApiKeyPermissionsMiddleware` (уже стояла в pipeline, ничего добавлять
  не пришлось). Двойной проверки нет: ручка `/api/v1/ops` прав ключа не проверяет вообще.
  `uploadMarkup` в ops.ts всегда получает `undefined` — транзактор НЕ умеет заливать markup
  (нет `@hcengineering/collaborator-client`), и вызывать его там не должен.
- **Новая доменная зависимость `@hcengineering/task` добавлена в `pods/server`** — вопреки исходному
  предположению задачи, что tracker/chunter/document/contact достаточно. `resolveStatus` резолвит
  имя статуса через `task.class.ProjectType`/`TaskType` (та же схема, что было в поде) — без прямого
  импорта `task` эти class-id взять неоткуда (pnpm strict node_modules, транзитивные пакеты не
  резолвятся). Потребовал `rush update` — без него симлинк в `pods/server/node_modules/@hcengineering/`
  не появляется и tsc не находит модуль.
- **Markup**: `ops.ts` (tracker/document) получили новое поле рядом с Markup —
  `descriptionRef?: MarkupBlobRef` (`NewIssue` в index.ts, `IssueUpdate` в ops.ts) и
  `contentRef?: Ref<Blob>` (`NewDocument`/`DocumentUpdateData`, оба в document/src/ops.ts). Если ref
  задан — берётся он, `uploadMarkup` не зовётся; иначе всё как раньше (UI-обёртки не трогали,
  `descriptionRef`/`contentRef` не задают — работают без изменений).
  Под грузит markup ДО вызова транзактора: `services/webhook/pod-webhook/src/consumer.ts::prepareBody`
  проходит по `markdownFields[action]` (таблица в новом слим `operations.ts` пода: какое поле для
  какого action — `blob` или `inline`) и для `blob`-полей (`description`/`content`) шлёт
  `rest.uploadMarkup(objectClass, generateId(), field, text, 'markdown')`, кладёт результат под
  `descriptionRef`/`contentRef`. **objectId для аплоада — одноразовый плейсхолдер (`generateId()`),
  не финальный `_id` документа** — проверено по коду коллаборатора
  (`foundations/core/packages/core/src/collaboration.ts::makeCollabJsonId`): blobId это просто
  `[objectId, objectAttr, timestamp].join('-')`, чистая строка-ключ в storage, retrieval потом идёт
  по возвращённому `Ref<Blob>` (`source`), а не по повторному вычислению collabId — так что
  несовпадение с финальным issue/document `_id` не ломает ничего. `message` (issue:comment/chat:post)
  — `inline`-поле, конвертится тем же `jsonToMarkup(markdownToMarkup(...))`, что и раньше, прямо в
  payload (текст, не блоб), транзактор берёт его как готовый Markup.
- `services/webhook/pod-webhook/src/operations.ts` — от старого реестра остались только
  `isKnownOperation` (теперь просто сверяет с `apiKeyOperations` из account-client, не с локальным
  списком — реестр-исполнитель уехал, дублировать список незачем) и таблица `markdownFields`.
- `src/workspaceClient.ts` — `RestClientAdapter`/кэш модели удалены. Осталось: `issueKeyToken` (форма
  не менялась), кэш ТОЛЬКО endpoint транзактора (`selectWorkspace` раз на воркспейс), `RestClient` на
  job ради `uploadMarkup`. `getWorkspaceClient` → `getTransactorTarget`.
- `src/consumer.ts` — `processJob` больше не резолвит `space` и не сверяет `job.spaces` вручную (эту
  проверку теперь делает транзактор через токен с `apiops`/`apispaces`); шлёт
  `POST {transactorUrl}/api/v1/ops/<action>/<workspace>` с `Authorization: Bearer <key-token>`.
  Ретраи через time-machine — без изменений.
- Тесты `operations.test.ts`/`consumer.test.ts` пода переписаны под новую форму (HTTP-мок вместо
  мока `TxOperations`). `pods/server/src/__tests__/opsApi.test.ts` — новый, копирует стиль старого
  webhook `operations.test.ts` (fakeClient с `findOne`/`findAll`/`addCollection`/`updateDoc`).

## 4xx не ретраится, отдельный лимит на ключ-в-пути (FUSIO-1151)

- `pods/server/src/opsApi.ts` — все ошибки разбора тела и резолва ссылок (`requireString`/
  `optionalString`/`optionalNumber`/`resolveProject`/`resolveIssue`/`resolveAssignee`/`resolveStatus`/
  `resolveTeamspace`/`resolveDocument`, `parsePriority`) идут через новый хелпер `badRequest(message)` —
  `PlatformError` со статусом `platform.status.BadRequest`. `pods/server/src/rpc.ts` уже превращал
  `PlatformError`+`BadRequest` в HTTP 400 (готовый код, не трогали). **Ловушка:** `PlatformError`
  сам генерит `.message` как `${severity}: ${code} ${JSON.stringify(params)}` — имя поля там есть, но
  экранированное (`\"space\"` вместо `"space"`), и `.rejects.toThrow('field "space": ...')` в тестах не
  матчился бы. Фикс — `err.message = message` поверх конструктора (сообщение с именем поля остаётся
  читаемым и в `params.message`, и в самом `.message`).
- `services/webhook/pod-webhook/src/consumer.ts` — `callTransactor` кидает `TransactorHttpError`
  (несёт `status` HTTP-ответа) вместо голого `Error`. `processJob` перехватывает: `status` 4xx →
  `store.markFailed` сразу, без похода в `retryOrFail`/time-machine; всё остальное (5xx, сетевые сбои,
  таймауты — не `TransactorHttpError` вовсе) — по-старому в backoff 30с/1м/2м/4м/8м.
- Лимиты (`src/config.ts`, `src/server.ts`): было два счётчика (`perKeyLimiter`, `perIpLimiter`) с
  одним общим `RateLimitMax`/`RateLimitWindowMs`. Стало три: `perKeyHeaderLimiter` (ключ в
  `Authorization`), `perKeyPathLimiter` (ключ в `/k/:key`, свой `RateLimitPathMax`, тот же
  `RateLimitWindowMs`), `perIpLimiter` (общий, без изменений). Путевой ключ целиком утекает в access-
  логи/прокси — лимит у него строже по построению, не только по духу.
- Числа по умолчанию (`RateLimitMax=60`/`RateLimitWindowMs=60000` — не менялись; `RateLimitPathMax=20`
  — новый) сверены с лимитами транзактора для юзеров/интеграций
  (`foundations/server/packages/server/src/sessionManager.ts`): обычный юзер 1500/30с (~50/с), system
  5000/30с, ключ-интеграция на самом транзакторе (`apiKeyLimitter`) 300/30с (~10/с). Дефолт webhook-
  пода по заголовку — 60/60с (1/с) — уже на порядок строже транзакторного `apiKeyLimitter`; путевой
  ключ строже ещё в 3 раза (20/60с).

## Счётчик входящих - `WebhookStat` (FUSIO-1151)

`consumer.ts` бампает `WebhookStat(in, job.keyId, job.action)` через общий с `delivery.ts`
`bumpWebhookStat` (`src/stats.ts`) СРАЗУ ПОСЛЕ `store.markDone` — только успешно исполненная операция
считается принятой; путь `store.markFailed` счётчик не трогает. Схема `_id`
(`${direction}:${target}:${type}`) и мотивация отдельного сателлит-документа вместо
`Record<type,number>` — см. `docs/memory/webhook_outgoing_delivery.md`.
