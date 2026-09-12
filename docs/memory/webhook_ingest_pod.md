# pod-webhook: приём + consumer

TSK-2026-09-01-009..014,021,022,054,056 (приём) + TSK-015..020,050,053 (consumer), всё в
`services/webhook/pod-webhook`. Смежное: [webhook_api_keys](webhook_api_keys.md),
[webhook_outgoing_delivery](webhook_outgoing_delivery.md),
[webhook_test_mocks](webhook_test_mocks.md).

## Ручки

- `POST /api/v1/webhook/action` - ключ в `Authorization: Bearer fus_...`
- `POST /api/v1/webhook/k/:key` - тот же ключ в пути
- `GET /api/v1/webhook/job/:id` - статус
- `GET /health` - без авторизации
- Воркспейса в пути нет: его отдаёт `accountClient.verifyApiKey` (`check.workspace`).

Порядок проверок: ключ(401) -> **валидность тела/action(400, добавлено сверх ТЗ - без него нечем
проверять право)** -> право(403) -> лимит(429) -> идемпотентность -> 202. Размер тела (413) enforced
раньше всего: `express.json({ limit: '1mb' })` кидает до захода в хендлер (защита от
неаутентифицированного DoS телом).

## Где что лежит

- Коды ошибок - один каталог в `src/errors.ts` (`{error: code, message}`, Slack-style).
- `WebhookJobMessage` (сообщение в `QueueTopic.Webhook`) - в `src/types.ts` пода, НЕ в
  `server-core`: агенту было запрещено трогать `foundations/server/packages/core` кроме
  `queue/types.ts`. Если consumer понадобится в другом поде - тип дублировать или выносить. Несёт
  `spaces: Ref<Space>[]` из `ApiKeyCheck`, чтобы consumer не делал повторный `verifyApiKey`.
- `check.spaces` НЕ сверяется с `body.space` в HTTP-хендлере: `space` в теле - id проекта/канала на
  стороне отправителя, а не `Ref<Space>`.

## ponytail-ограничения (искать при добавлении второй реплики)

`src/store.ts` (`WebhookStore`) держит идемпотентность (`Idempotency-Key`, TTL ~сутки) и статус
задания (`queued`/`done`/`failed` + `result`/`error`) в памяти процесса, lazy sweep по TTL. Одному поду
этого хватает; несколько реплик за LB требуют общего кэша (Redis). Тот же факт значит: если consumer и
HTTP-ручка окажутся в разных подах, `GET /job/:id` не увидит статус от consumer - сейчас `main.ts`
создаёт один `WebhookStore` и отдаёт его и в `createServer`, и в `startConsumer`.

## Consumer

- Резолв ссылок и исполнение операций живут в транзакторе (см. ниже). В поде остались
  `isKnownOperation` (сверяет с `apiKeyOperations` из account-client) и таблица `markdownFields`.
- Повторы (TSK-020) - через time-machine: `{type:'schedule', id: jobId, targetDate, topic:
  QueueTopic.Webhook, data: nextJob}` в `QueueTopic.TimeMachine`. Топик `QueueTopic.Webhook` под НЕ
  создаёт (чужой - `services/worker`, он же time-machine, в проде `enabled: false`, см.
  `foundation-tasks/docs/infra/2026-08-29-201-time-machine-deploy.md`). Backoff 30с/1м/2м/4м/8м, 5
  попыток, потом dead-letter в `failed`. Если продюсер в `QueueTopic.TimeMachine` падает (топика
  нет/брокер недоступен) - job сразу `failed` с причиной, а не висит в `queued` навечно (`//
  ponytail:` в `src/consumer.ts`).
- Резолв покрыл все 6 операций через существующие
  `createIssue`/`updateIssue`/`commentIssue`/`postMessage`/`resolveChannel`/`createDocument`/`updateDocument`
  без обходных путей.

## Прочее

- Сервисный токен: `generateToken(systemAccountUuid, undefined, { service: 'webhook' })`, с ним
  ходит `accountClient.verifyApiKey`.
- Rate limit - `SlidingWindowRateLimitter` из `@hcengineering/rpc`. Заголовки 429 - ровно формат
  `rateLimitToHeaders` из `pods/server/src/rpc.ts`.
- QueueTopic добавлены в `foundations/server/packages/core/src/queue/types.ts`: `Webhook` (входящие)
  и `WebhookDelivery` (исходящие).
- Никакого morgan/access-log в этом поде специально: путь `/k/:key` содержит ключ в URL,
  request-логгер утёк бы его. Логируем только `keyId` (после verifyApiKey), никогда сырой ключ.

## Исполнение операций переехало в транзактор (FUSIO-1151)

Под больше не держит модель воркспейса и не строит `TxOperations` - только аутентифицирует ключ,
лимитирует, кладёт в очередь; consumer шлёт HTTP в транзактор.

- `pods/server/src/opsApi.ts` - реестр `Record<ApiKeyOperation, OpsExecutor>`, перенесённый почти
  один в один из бывшего `src/operations.ts` пода (резолв
  project/issue/assignee/status/teamspace/document). Разница: `WebhookResolved{space, commit}`
  схлопнута в `(client, payload) => Promise<Record<string,unknown>>` - ручной `spaces`-гейт между
  resolve/commit убран, эту проверку теперь на каждый tx делает `ApiKeyPermissionsMiddleware` (уже
  стояла в pipeline). Двойной проверки нет: ручка `/api/v1/ops` прав ключа не проверяет вообще.
  `uploadMarkup` в ops.ts всегда получает `undefined` - транзактор НЕ умеет заливать markup (нет
  `@hcengineering/collaborator-client`).
- Правила резолва (унаследованы от пода): проект - `findOne(tracker.class.Project, {identifier})`;
  задача - `findOne(..., {identifier})` (в `issue:update`/`issue:comment` `body.space` это
  идентификатор ЗАДАЧИ, не проекта, а `Ref<Space>` берётся из `issue.space`); канал -
  `resolveChannel` из `@hcengineering/chunter`; исполнитель - `contact.class.SocialIdentity` по
  `{type: SocialIdType.EMAIL, value}` -> `.attachedTo`; статус - по имени case-insensitive среди
  статусов task-типа проекта (дубль приватного `resolveTaskType` из `plugins/tracker/src/ops.ts`, он
  не экспортирован); teamspace - по имени; `parent`-документ и обновляемый документ - СЫРОЙ
  `Ref<Document>` (ponytail: у документов нет человеческого идентификатора вроде `FUSIO-42`).
- **Новая доменная зависимость `@hcengineering/task` в `pods/server`** (вопреки исходному
  предположению, что tracker/chunter/document/contact достаточно): `resolveStatus` резолвит имя
  через `task.class.ProjectType`/`TaskType`, без прямого импорта class-id взять неоткуда (pnpm
  strict node_modules). Потребовал `rush update`, иначе симлинка нет и tsc не находит модуль.
- **Markup**: `ops.ts` (tracker/document) получили рядом с Markup поля `descriptionRef?:
  MarkupBlobRef` (`NewIssue`, `IssueUpdate`) и `contentRef?: Ref<Blob>`
  (`NewDocument`/`DocumentUpdateData`). Если ref задан - берётся он, `uploadMarkup` не зовётся. Под
  грузит markup ДО вызова транзактора: `consumer.ts::prepareBody` идёт по `markdownFields[action]`
  (`blob` или `inline`) и для `blob`-полей (`description`/`content`) шлёт
  `rest.uploadMarkup(objectClass, generateId(), field, text, 'markdown')`. **objectId для аплоада -
  одноразовый плейсхолдер (`generateId()`), не финальный `_id`**: по
  `foundations/core/packages/core/src/collaboration.ts::makeCollabJsonId` blobId это `[objectId,
  objectAttr, timestamp].join('-')`, чистая строка-ключ в storage; retrieval идёт по возвращённому
  `Ref<Blob>`, а не по повторному вычислению collabId - несовпадение ничего не ломает. `message`
  (issue:comment/chat:post) - `inline`-поле, конвертится `jsonToMarkup(markdownToMarkup(...))` прямо
  в payload, транзактор берёт готовый Markup. Для `description`/`content` конвертация не нужна:
  сырой markdown прокидывается как `Markup` (`type Markup = string`) и уходит в `uploadMarkup` с
  явным форматом `'markdown'`.
- `src/workspaceClient.ts` - `RestClientAdapter`/кэш модели удалены. Осталось: `issueKeyToken`, кэш
  ТОЛЬКО endpoint транзактора (`selectWorkspace` раз на воркспейс), `RestClient` на job ради
  `uploadMarkup`. `getWorkspaceClient` -> `getTransactorTarget`.
- `src/consumer.ts::processJob` шлёт `POST {transactorUrl}/api/v1/ops/<action>/<workspace>` с
  `Authorization: Bearer <key-token>`.
- Тесты `operations.test.ts`/`consumer.test.ts` переписаны под HTTP-мок вместо мока `TxOperations`.
  `pods/server/src/__tests__/opsApi.test.ts` - новый (fakeClient с
  `findOne`/`findAll`/`addCollection`/`updateDoc`).

## 4xx не ретраится, отдельный лимит на ключ-в-пути (FUSIO-1151)

- `opsApi.ts` - все ошибки разбора тела и резолва
  (`requireString`/`optionalString`/`optionalNumber`/`resolveProject`/`resolveIssue`/`resolveAssignee`/`resolveStatus`/`resolveTeamspace`/`resolveDocument`,
  `parsePriority`) идут через `badRequest(message)` - `PlatformError` со статусом
  `platform.status.BadRequest`, который `rpc.ts` уже превращал в HTTP 400. **Ловушка:**
  `PlatformError` сам генерит `.message` как `${severity}: ${code} ${JSON.stringify(params)}` - имя
  поля там экранировано (`\"space\"`), и `.rejects.toThrow('field "space": ...')` не матчился бы.
  Фикс - `err.message = message` поверх конструктора.
- `consumer.ts::callTransactor` кидает `TransactorHttpError` (несёт `status`) вместо голого `Error`.
  `processJob`: 4xx -> `store.markFailed` сразу, без time-machine; 5xx/сетевые/таймауты - в backoff.
- Лимиты (`src/config.ts`, `src/server.ts`): три счётчика - `perKeyHeaderLimiter` (`Authorization`,
  `RateLimitMax=60`/`RateLimitWindowMs=60000`), `perKeyPathLimiter` (`/k/:key`, свой
  `RateLimitPathMax=20`, то же окно), `perIpLimiter`. Путевой ключ целиком утекает в
  access-логи/прокси - лимит строже по построению.
- Сверено с транзактором (`sessionManager.ts`): юзер 1500/30с (~50/с), system 5000/30с,
  ключ-интеграция `apiKeyLimitter` 300/30с (~10/с). Дефолт пода по заголовку 60/60с уже на порядок
  строже, путевой - ещё втрое.

## Счётчик входящих - `WebhookStat` (FUSIO-1151)

`consumer.ts` бампает `WebhookStat(in, job.keyId, job.action)` через общий с `delivery.ts`
`bumpWebhookStat` (`src/stats.ts`) СРАЗУ ПОСЛЕ `store.markDone` - считается только успешно
исполненная операция; путь `store.markFailed` счётчик не трогает. Схема `_id` и мотивация
сателлит-документа - см. [webhook_outgoing_delivery](webhook_outgoing_delivery.md).
