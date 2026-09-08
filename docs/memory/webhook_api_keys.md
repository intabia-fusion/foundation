# Webhooks / API keys (FUSIO-1151)

План: `../foundation-tasks/docs/integrations/2026-09-01-001-webhooks-api-keys.md`
(TSK-2026-09-01-001..069). Смежное: [webhook_ingest_pod](webhook_ingest_pod.md),
[webhook_outgoing_delivery](webhook_outgoing_delivery.md).

## Этап 1: бэкенд ключей (TSK-001..006)

- `SocialIdType.WEBHOOK = 'webhook'` (`foundations/core/packages/core/src/classes.ts`), значение
  соц.id = keyId -> `webhook:<keyId>`.
- Миграции `account_db_v42` (значение enum `social_id_type`), `v43` (индекс
  `integration_secrets(kind, key)` - до него verify был full scan), `v44`
  (`workspace.max_api_keys`). v42 и v43 РАЗДЕЛЬНО: PG запрещает использовать значение enum в той же
  транзакции.
- `server/account/src/apiKeys.ts` (формат, хеш, маска, проверки прав/срока); ops
  `createApiKey`/`listApiKeys`/`revokeApiKey` в `operations.ts` (только Owner воркспейса или admin);
  `verifyApiKey` в `serviceOperations.ts` (только сервисы `webhook`/`tool`); клиентские методы в
  `account-client/src/client.ts`; тест `server/account/src/__tests__/apiKeys.test.ts`.

### Решения, которых нет в плане

- **Формат hex, не base62**: `fus_<ws-short>_<64 hex>`. Части режутся по `_`, base64url содержит `_`, из-за чего
  маска и разбор ломались (поймал тест). Энтропия та же, 32 байта.
- **`IntegrationSecret.key` = sha256 самого ключа**, не keyId: по предъявленному ключу иначе строку
  не найти (keyId в него не зашит). Проверка = один индексный lookup, сравнивать в коде нечего ->
  timing-атака невозможна. keyId лежит в JSON `secret` (UI, отзыв, соц.id).
- **Типы дублируются** между `account-client/src/types.ts` и `server/account/src/apiKeys.ts` (как
  `AdminAction`): `server/account` намеренно не зависит от `account-client`.
- **Чтение даётся автоматически**: `ApiKeyOperation` - только записи, `spaces` ограничивает и чтение
  и запись. Пустой список операций валиден = ключ только на чтение (`isApiKeySpaceAllowed` /
  `isApiKeyAllowed`).
- **`spaces: Ref<Space>[]`**, не `string[]` - типобезопасность для webhook-сервиса и UI; резолв
  `FUSIO` -> `Ref<Space>` на вызывающей стороне.
- **`lastUsed` пишется не чаще раза в минуту** (`lastUsedResolutionMs`).

## Этап 1b: слой операций (TSK-043..048, 052)

Правило "создать задачу/документ" переехало из UI-пакетов в модельные, чтобы им пользовался и
сервер.

- `plugins/tracker/src/ops.ts` (`createIssue`/`updateIssue`/`commentIssue`, тип `UploadMarkup`),
  `plugins/chunter/src/ops.ts` (`postMessage`, `resolveChannel`: по `_id`, иначе по имени;
  неоднозначность - ошибка), `plugins/document/src/ops.ts` (`createDocument`/`updateDocument`).
- Зависимость на UI разорвана инъекцией последнего необязательного аргумента `uploadMarkup:
  (collabId, markup) => Promise<Ref<Blob>>`. UI передаёт `presentation.createMarkup`. Никаких
  контейнеров и фабрик.
- Обёртки в UI: `plugins/tracker-resources/src/createIssue.ts` (11 строк), `createEmptyDocument` в
  `plugins/document-resources/src/utils.ts` (8 строк) - только подстановка `createMarkup` и
  дефолтного заголовка.
- `createSubIssue` не писали: `data.parent` в `createIssue` уже даёт подзадачу.
- `createDocument` принимает `Ref<Teamspace>`, а `createIssue` - целиком `Project` (нужны
  `identifier`, `sequence`, `defaultIssueStatus`).
- Зависимости: `@hcengineering/text-core` (только `isEmptyMarkup`), НЕ `@hcengineering/text` (тянет
  tiptap/prosemirror). `IconProps` - из `@hcengineering/view`.
- Чат не сводили: `ChatMessageInput.svelte` богаче `postMessage` (черновики, вложения, typing,
  форвард, треды) - сведение регрессировало бы фичи.

## Этап 1a: вход по ключу и места (TSK-035, 037, 038)

- `loginWithApiKey(key)` в account (токен вызывающего не нужен): хеш -> строка секрета ->
  `isApiKeyUsable` -> промежуточный токен с `extra: { apikey: keyId }` -> прогон через существующий
  `selectWorkspace`, который и собирает `WorkspaceLoginInfo`. Руками объект не собирается. Отказ
  всегда `Unauthorized` без деталей.
- `createApiKey` заводит и аккаунт: `createAccount` + `assignWorkspace(role User)`, БЕЗ
  `assertSeatAvailableOnJoin`. `revokeApiKey` снимает членство; person/socialId остаются - на них
  ссылается история задач.
- Место снимается через `LimitsProvider.getIntegrationAccounts` (новый метод) + `seatEligible`. НЕ
  через `getSystemAccounts` - тот обходит весь enforcement.

Две ловушки, найденные при ревью:

- **Исключение из seatSet само по себе ломало фичу**: `tx()` в `seatLimits.ts` шлёт в read-only
  каждого, кого нет в `seatSet`, а интеграционный аккаунт туда не попадает по построению. Нужен
  явный bypass в `tx()` рядом с `GUEST_ROLES` (снимается только seat-деградация, `isSystemAccount`
  не трогаем). Тест `lets an API-key integration account write even with every seat taken`.
- **`publishMembersChanged` не звался** при выпуске/отзыве: seat-логика перестраивает наборы по
  members-version, без бампа новый ключ ей неизвестен до рестарта пода.

## Ключ не пускает в UI - проверка на КЛИЕНТЕ

`plugins/workbench-resources/src/connect.ts`, сразу после получения токена: если
`decodeTokenPayload(token).extra?.apikey` задан - `logOut()` и уход на вход. `decodeTokenPayload`
уже есть в `@hcengineering/presentation` (тем же приёмом читает `extra`
`plugins/guest-resources/src/components/Guest.svelte:54`).

**Почему не на сервере**: первая попытка отклоняла такой токен в `httpServer.on('upgrade')`
(`pods/server/src/server_http.ts`) - но `api-client` тоже работает по WebSocket, запрет убил бы
интеграции. Откачено.

`selectWorkspace` (`server/account/src/utils.ts:895`) переносит `extra` из входного токена в
выходной - достаточно проверять итоговый.

Граница честная: защита от подменённого в local storage токена, а не от того, кто пишет свой клиент.
Настоящая граница прав - `ops`/`spaces` (см. ниже).

## Права ключа на транзакторе (ApiKeyPermissionsMiddleware)

`loginWithApiKey` кладёт в `extra` рядом с `apikey` ещё `apiops` и `apispaces` (списки через
запятую; пустое поле не кладётся); `selectWorkspace` переносит `extra` как есть. Права протухают
вместе с токеном, отдельного отзыва нет.

`foundations/server/packages/middleware/src/apiKeyPermissions.ts`, зарегистрирован в
`server/server-pipeline/src/pipeline.ts` сразу после `GuestPermissionsMiddleware`. Проброс:
`SessionData.apiKey` (`foundations/core/packages/core/src/server.ts`), заполняется в `ClientSession`
(`foundations/server/packages/server/src/client.ts`) рядом с `permissionsGrantCached`.

Права считает `ClientSession.computeApiKeyPermissions()` -> `ctx.contextData.apiKey = {canWrite,
opsOnly, spaces}`.

**Только записи.** Нет `apiops`/`apiall` -> `canWrite: false`, любая CUD запрещена. `opsOnly`
(именованные ops, не `apiall`) -> запись разрешена ТОЛЬКО если транзакция пришла через `/api/v1/ops`
(`contextData.opsApi === true`): иначе ключ с `ops: ['chat:post']` писал бы что угодно через сырой
tx-API. `apiall` (личный unrestricted) пишет любым маршрутом под своей ролью. Непустой `apispaces`
-> запись только в них (`DerivedTx` исключён).

Две ловушки:
- **Фильтр ЧТЕНИЯ по spaces ломал фичу и убран**: `ProjectType`, `TaskType`, статусы, персоны лежат
  ВНЕ пространств проектов из ключа; `findAll` с `space: {$in: spaces}` отрезал их, и `createIssue`
  падал на первом `findOne(task.class.ProjectType)`. Сужение чтения - забота webhook-пода.
- **`core.space.DerivedTx` надо пропускать** (как в `GuestPermissionsMiddleware`): производные
  транзакции порождают триггеры, а не ключ, и уходят в чужие пространства.

`PermissionsGrant.spaces` переиспользовать нельзя: он не ограничивает чтение (`grant` никто не
читает в `FindSecurityMiddleware`/`SpaceSecurityMiddleware`), а `getLoginInfoByToken`
(`server/account/src/operations.ts:1899`) кидает Forbidden на токен, где заданы и `workspace`, и
`grant`.

## Webhook-под ходит по REST и ОТ ИМЕНИ КЛЮЧА

`services/webhook/pod-webhook/src/workspaceClient.ts`.

- **Токен интеграционного аккаунта, а не сервисный.** Первая версия ходила
  `generateToken(systemAccountUuid, ..., { service: 'webhook' })` - это обходило ВЕСЬ enforcement
  (права ключа: нет `extra.apikey` -> middleware молчит; счётные лимиты; режим неоплаты). Теперь под
  сам выпускает `generateToken(personUuid, ws, { apikey, apiops, apispaces })` - той же формы, что
  `loginWithApiKey`; держать их в согласии.
- Ключ в очередь не кладём: job несёт `keyId`, `personUuid`, `socialId`, `ops`, `spaces`.
- REST, не сокет: под делает одну операцию и забывает, сокет держал бы подписку на весь поток
  транзакций.

## Операции исполняет ТРАНЗАКТОР, под только проксирует

`POST /api/v1/ops/:operation/:workspaceId` в `pods/server/src/rpc.ts`, реестр и резолв ссылок -
`pods/server/src/opsApi.ts` (переехал из пода). Форма как у соседней `/api/v1/create`: `withSession`
-> `wrapPipeline` -> `new TxOperations(client, primarySocialId)`.

Почему: модель воркспейса у транзактора уже есть, а под держал копию на каждый воркспейс
(`RestClientAdapter` + кэш моделей удалены). Автор транзакций и права ключа получаются даром - под
токеном ключа `primarySocialId` это интеграционный аккаунт, а `ApiKeyPermissionsMiddleware`
отрабатывает сам. Двойной проверки `spaces` больше нет.

`pods/server` уже зависел от `tracker`/`chunter`/`document`/`contact`; добавлен только
`@hcengineering/task` (резолв статуса через `ProjectType`/`TaskType`).

**Markup заливает под**, не транзактор: у транзактора нет зависимости на collaborator-client. Под
зовёт `RestClient.uploadMarkup` и шлёт готовый `Ref<Blob>` в `descriptionRef`/`contentRef`
(добавлены в `NewIssue`/`IssueUpdate`/`NewDocument`/`DocumentUpdateData` рядом с `Markup`,
опциональны, UI-обёртки не тронуты).

### Дыра, созданная переносом (закрыта)

Ручка `/api/v1/ops/*` публичная, ключ может звать её напрямую минуя под. Проверку "операция входит в
`ops` ключа" раньше делал под, а middleware имена операций не смотрит по замыслу -> ключ с `ops:
['chat:post']` создавал бы задачи. Теперь ручка сверяет `:operation` с `extra.apiops`
(`isOperationGranted` в `opsApi.ts` + тест). Токен без `apiops` не ключевой, ничего не сужаем.

## Срок жизни токена задаёт владелец (1-90 суток), ротация ручная

`ApiKeySecret.tokenTtlMs` (+ то же в account-client), границы `minApiKeyTokenTtlMs` (1 сутки) /
`maxApiKeyTokenTtlMs` (90 суток), дефолт 7 суток. Валидация на сервере в `createApiKey`, не только в
UI. `loginWithApiKey` берёт `secret.tokenTtlMs ?? defaultApiKeyTokenTtlMs`. НЕ путать с `expiresOn`
(когда перестаёт действовать САМ КЛЮЧ) - поля намеренно раздельные. Автообновления токена нет: истёк -
зови `loginWithApiKey` заново.

Лимиты: `apiKeyLimitter` в `sessionManager.checkRate` - 300/30с (~10 rps) против 1500/30с у юзера и
5000/30с у системного. В поде: 60/60с для ключа в заголовке, 20/60с для ключа в пути (URL утекает в
логи целиком).

### Дыра с Owner - закрыта

`sessionManager.addSession`: ветка `wsInfo === undefined` (нет членства) собирала `wsInfo` с `role:
AccountRole.Owner` (задумана для гостевого и системного аккаунта), а `revokeApiKey` снимает членство
-> отозванный ключ с живым токеном становился ВЛАДЕЛЬЦЕМ. Теперь токен с `extra.apikey` без членства
получает `UNAUTHORIZED, terminate: true` до этой ветки.

Перепроверено: `role: Owner` в этой ветке был мёртвым полем - `getWorkspace()` его не читает,
`createSession()` берёт роль из `info.workspaces[workspace.uuid]?.role` с фолбэком `User` и
форсирует `Owner`/`DocGuest` только по `info.account === systemAccountUuid`/`guestAccount`. На
всякий случай заменено на `AccountRole.ReadOnlyGuest` (нижняя роль в `roleOrder`).

### Отзыв НЕ обрывает активную сессию - ОТКРЫТО

`pods/server/src/rpc.ts:withSession` кэширует сессию по строке токена, `addSession` (и проверка
членства) зовётся один раз на токен. Сессия живёт, пока запросы приходят чаще
`hangSessionTimeoutSeconds` = 60с. `revokeApiKey` шлёт только `publishMembersChanged`, его слушает
seat-limits, не sessionManager.

Итог: интеграция, дёргающая API чаще раза в минуту, переживёт отзыв до истечения токена (до 90
суток). Эскалация до Owner закрыта, доступ не обрывается.

Путь для починки: `pods/server/src/server.ts` уже потребляет `LimitCategory.Members` и бампает
`membersVersion` - там же закрывать/инвалидировать сессии с `extra.apikey`.

## Два вида ключей, флаги и квоты (позже этапа 1)

- **Интеграционный** (выпускает Owner/admin, `verifyApiKeyOwner`): свой `Person` +
  `SocialIdentity(WEBHOOK)` через `db.ensurePerson`, сразу `verifiedOn` (иначе UI показывает автора
  как "System"), теневой неподтверждённый аккаунт, роль `User`, места не занимает. Отзыв снимает
  членство.
- **Личный** (`personal: true`, выпускает себе любой не-гость, `verifyApiKeyMember`): свой
  `SocialIdentity(WEBHOOK, value=keyId)` на СОБСТВЕННОМ person человека через `addSocialIdBase` -
  членство, место и роль остаются человеческими, но транзакции ключа отличимы от набранных руками.
  Раньше переиспользовался старейший подтверждённый socialId человека, и ключ был неотличим от него.
  Квота 5 на пользователя, независимо от интеграционной. Отзыв членства не трогает.
- `unrestricted` валиден только вместе с `personal`: полные права пользователя, `ops` не
  используется (`apiall: '1'` в токене вместо `apiops`), `spaces` всё равно сужает. `verifyApiKey`
  для таких ключей возвращает полный `apiKeyOperations` как `ops`, чтобы проверка "разрешён ли
  action" на входе была единообразной.
- `incoming` - независимый флаг "можно звать ingest-ручки пода"; без него отказ независимо от
  `ops`/`unrestricted`.
- Квота интеграционных: `ws.maxApiKeys ?? apiKeyLimitPerWorkspace` (env
  `API_KEY_LIMIT_PER_WORKSPACE`, дефолт 5). Переопределение ставит admin:
  `adminUpdateApiKeyLimit(workspace, maxApiKeys|null, otpCode)` (`serviceOperations.ts:835`,
  OTP-gated + аудит, `null` = сброс на env), UI -
  `plugins/admin-resources/src/.../WorkspaceDetails.svelte`. Миграция `account_db_v44` добавляет
  `workspace.max_api_keys`.
- `listApiKeys` отдаёт `{keys, limit, personalLimit}`; Owner/admin видят все ключи, обычный участник -
  только свои личные.
- Письма о выпуске и отзыве ключа шлются (TSK-008 закрыт): владельцам воркспейса для
  интеграционного, самому себе для личного, через `getWorkspaceOwnerEmails`. Падение почты не роняет
  операцию.
- UI (TSK-007 закрыт): `plugins/setting-resources` - `ApiKeyPopup` (переименован из
  `ApiTokenPopup`), `ApiKeyTable`/`ApiKeyRow`/`ApiKeysSection`, `CreateApiKeyPopup`,
  `ApiKeyOperationsPopup`, `ApiKeySpacesPopup`, категория настроек `integrations` в `models/setting`
  (`role: AccountRole.User`; Owner-only секция вебхуков гейтится внутри компонента).

## Time-machine (services/worker) - проверена и починена

Тестов не было вовсе. Найдено и исправлено:

- `ctx.error('Error in Time Machine polling loop:')` - объект ошибки не передавался, причина сбоя
  терялась.
- `SendTimeEvent` создавал новый `getPlatformQueue()` (Kafka-клиент с TCP-соединением) на КАЖДОЕ
  событие и не закрывал. Теперь очередь передаётся снаружи, продюсер кэшируется
  `queue.getProducer()`. Добавлен SIGINT/SIGTERM (останов поллинга, `queue.shutdown()`,
  `db.close()`) - раньше обработчика не было.
- "отправить все -> удалить все": сбой одной отправки оставлял в БД всю пачку. Теперь per-event
  try/catch, удаляются только отправленные.
- `getExpiredEvents()` без `LIMIT`/`ORDER BY` -> при накоплении вытаскивал всё разом в
  непредсказуемом порядке. Теперь `LIMIT 500` + `ORDER BY target_date ASC`.

Тесты: `services/worker/src/__tests__/{db,worker,db-real,activities}.test.ts`, 55 passed (db-real
скипается без `WORKER_TEST_DB_URL`). Пакет - `@hcengineering/pod-worker`, не
`@hcengineering/worker`.

**`removeEvents` намеренно использует `ILIKE`, а не `=`** - это контракт: `services/process`
отменяет таймеры по префиксу (`id: '<execution>_%'`). Наши `jobId` вида `wh_<id>` содержат `_`,
который в LIKE значит "любой символ" - зафиксировано тестом (`wh_1` cancel также снимает `whX1`).
Сейчас webhook-consumer `cancel` не шлёт; начнёт - экранировать `_` и `%`.

### Расширение покрытия (2026-09-01)

Backlog > LIMIT дренится по двум поллам без потерь/переупорядочивания; повторный `schedule` тем же
id переезжает на новый срок (одна строка); `activities.test.ts` - `SendTimeEvent` берёт продюсер
через `queue.getProducer`, не плодит свой кэш; `stop()` во время незавершённого `pollOnce` не
планирует следующий тик; неизвестный `type` в `TimeMachineMessage` - no-op; `data` переживает
JSON-круг (фейковый `postgres.Sql` в `db.test.ts` - `createFakeClient`, экспортирован - реально
гоняет `data` через `JSON.parse(JSON.stringify())` при INSERT, как настоящая `jsonb`).

**db-real.test.ts прогонялся по-настоящему** против поднятого `sanity-postgres-1` (`postgres:18`,
порт 5433). Схема совпадает с `db.ts` (`id text, workspace uuid, target_date bigint, topic text,
data jsonb`, PK `(id, workspace)`). Хрупкий момент (не баг, не чинил): `getExpiredEvents()` не
скоупится по workspace и берёт глобально старейшие `LIMIT` строк - мусор со старыми `target_date` от
упавшего прогона может закрыть свежие события лимитом.

Остаточное: нет метрик и health (не видно backlog и отставание); окно redelivery между send и delete
(нужна идемпотентность получателя - у пода она есть через `jobId`); сервис выключен в проде, чарт не
передаёт `DB_URL`.

## Time-machine + webhook на dev/tests/ws-tests стендах (2026-09-01)

`dev/` и `tests/docker-compose.yaml` уже держали `time-machine` (image `intabiafusion/worker`); в
`ws-tests/` его не было - добавлен. `webhook` (image `intabiafusion/webhook`) не был поднят нигде -
добавлен во все три. Оба в `rush.json` (`@hcengineering/pod-worker`, `@hcengineering/pod-webhook`).

- Схема `time_machine.delayed_events` создаётся самим сервисом на старте (`TimeMachineDB.init`),
  миграции не нужно.
- `POLL_INTERVAL`: дефолт 20с в `dev`, `2000` в `tests/` и `ws-tests/` (иначе тест на повтор
  доставки ждал бы 20с).
- `webhook` не трогает БД: только `SECRET`, `ACCOUNTS_URL` (обязательны), `PORT` (умолчание 4043),
  `QUEUE_CONFIG`/`QUEUE_REGION`. Retry шлёт в `QueueTopic.TimeMachine`, топик не создаёт. Зависит от
  `redpanda`+`account`, не от `postgres`/`time-machine`.
- Наружу оба через nginx по образцу `billing`/`payment` (path-роутинг): upstream + `location
  /_webhook` в `dev/`, `tests/`, `ws-tests/nginx.conf`. Изнутри compose-сети - `webhook:4043`.
- Документация - `dev/readme.md` и `tests/readme.md` (разделы "Time-machine + webhook"). У
  `ws-tests/` своего readme нет ни у одного сервиса - не плодили.

## Helm-чарт (fusion-deployment)

`charts/fusion/templates/webhook/` - deployment + service + traefik IngressRoute на `/_webhook`
(калька с billing: `strip-webhook` middleware, порт 4043 за service:80). `FRONT_URL` берётся из
configmap-ключа `frontUrl`, `WEBHOOK_SERVICE_URL` во front - из нового ключа `webhookServiceUrl`
(`https://<host>/_webhook`).

`templates/worker` в чарте - это time-machine (`intabiafusion/worker`, README пакета:
"replaces the previous Temporal implementation"). В чарте у него висел мёртвый temporal-env
(`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `ACCOUNTS_URL`) и НЕ передавался `DB_URL` - сервис
молча уезжал на дефолт `postgres://localhost:5432/huly`. Теперь `DB_URL` из
`anticrm-secret/dbUrl` + `POLL_INTERVAL` из `services.worker.pollInterval` (20000). Схему
`time_machine.delayed_events` сервис создаёт сам, отдельной миграции не нужно.

Оба сервиса `enabled: false` в дефолтах чарта и в `deployments/values.production.yaml`: с
выключенными флагами чарт не рендерит ни одного объекта под них, поэтому текущую версию можно
катить как раньше, пока ветка не влита. У обоих есть `services.<svc>.image` - полный override
образа мимо `global.version` (`intabiafusion/webhook:FUSIO-1151`), чтобы поднять невлитый под.

Пока `worker` выключен, ретраи обеих сторон (входящей и исходящей) не работают вообще - они
целиком на time-machine, своих таймеров у пода нет.

## Автора транзакций выбирает сессия, а не `integrationSecret.socialId`

`integrationSecret.socialId` - только бухгалтерия account-сервиса; транзактор его не читает никогда.
Автор берётся из `session.getRawAccount().primarySocialId` (`pods/server/src/rpc.ts:608` и соседние
пишущие маршруты), а тот считается один раз в `sessionManager.createSession`
(`foundations/server/packages/server/src/sessionManager.ts`) как `pickPrimarySocialId(info.socialIds)`
по ВСЕМ подтверждённым socialId аккаунта. Правило: сначала HULY, иначе первая строка неотсортированного
`find`.

Интеграционный ключ живёт с этим только потому, что у его собственного аккаунта Huly-id намеренно
оставлен неверифицированным - выбирать больше нечего. Для личного ключа этот трюк не работает: аккаунт
человеческий, Huly-id у него настоящий и выиграл бы всегда.

Поэтому `loginWithApiKey` кладёт в `extra` ещё `apisid` = socialId ключа, а `createSession` предпочитает
его - но только если он есть в `info.socialIds` (подтверждённые id аккаунта), иначе честный фолбэк на
`pickPrimarySocialId`. Тот же `apisid` кладёт `issueKeyToken` в поде
(`services/webhook/pod-webhook/src/workspaceClient.ts`) - формы токенов держать в согласии.
