# Webhooks / API keys (FUSIO-1151)

План: `../foundation-tasks/docs/integrations/2026-09-01-001-webhooks-api-keys.md` (TSK-2026-09-01-001..069).

## Сделано: этап 1, бэкенд ключей (TSK-001..006)

- `SocialIdType.WEBHOOK = 'webhook'` (`foundations/core/packages/core/src/classes.ts`), значение социального id = keyId,
  так что социальный ключ читается как `webhook:<keyId>`.
- Миграции `account_db_v42` (значение enum) и `v43` (индекс `integration_secrets(kind, key)`) -
  раздельно, PG запрещает использовать значение enum в той же транзакции.
- `server/account/src/apiKeys.ts` - формат, хеш, маска, проверки прав/срока.
- Ops в `operations.ts`: `createApiKey`, `listApiKeys`, `revokeApiKey` (только Owner воркспейса или admin).
- `verifyApiKey` в `serviceOperations.ts` - только для сервисов `webhook`/`tool`.
- Клиентские методы в `foundations/core/packages/account-client/src/client.ts`.
- Тест `server/account/src/__tests__/apiKeys.test.ts`.

## Решения, которых нет в плане

- **Формат ключа - hex, не base62.** `fus_<ws-short>_<64 hex>`. Части режутся по `_`, а base64url
  содержит `_` - маска и разбор ломались (тест это и поймал). Энтропия та же, 32 байта.
- **`IntegrationSecret.key` = sha256 самого ключа**, не keyId. Иначе по предъявленному ключу строку
  не найти: keyId в него не зашит. Проверка = один индексный lookup по хешу, сравнивать в коде
  нечего, timing-атака невозможна. keyId лежит в JSON `secret` - для UI, отзыва и социального id.
- **Типы дублируются** между `account-client/src/types.ts` и `server/account/src/apiKeys.ts` -
  как `AdminAction`; `server/account` намеренно не зависит от `account-client`.
- **Чтение даётся автоматически.** `ApiKeyOperation` - только записи; `spaces` ограничивает и чтение,
  и запись. Пустой список операций валиден: это ключ только на чтение (`isApiKeySpaceAllowed` для
  чтений, `isApiKeyAllowed` для записей).
- **`spaces: Ref<Space>[]`**, не `string[]` - брендированная строка, рантайм тот же, но webhook-сервис
  и UI получают типобезопасность; резолв `FUSIO` -> `Ref<Space>` делает вызывающая сторона.
- **`lastUsed` пишется не чаще раза в минуту** (`lastUsedResolutionMs`) - иначе запись в БД на
  каждый вызов ключа.

## Сделано: этап 1b, слой операций (TSK-043..048, 052)

Правило "создать задачу/документ" переехало из UI-пакетов в модельные, чтобы им пользовался и сервер.

- `plugins/tracker/src/ops.ts` - `createIssue`, `updateIssue`, `commentIssue`, тип `UploadMarkup`.
- `plugins/chunter/src/ops.ts` - `postMessage`, `resolveChannel` (по `_id`, иначе по имени; неоднозначность - ошибка).
- `plugins/document/src/ops.ts` - `createDocument`, `updateDocument`.
- Зависимость на UI разорвана инъекцией: последний необязательный аргумент
  `uploadMarkup: (collabId, markup) => Promise<Ref<Blob>>`. UI передаёт `presentation.createMarkup`,
  сервер потом подставит `uploadMarkup` из api-client. Никаких контейнеров и фабрик.
- Обёртки в UI-пакетах: `plugins/tracker-resources/src/createIssue.ts` (11 строк) и
  `createEmptyDocument` в `plugins/document-resources/src/utils.ts` (8 строк) - тела больше нет,
  только подстановка `createMarkup` и дефолтного заголовка.
- `createSubIssue` НЕ писали: `data.parent` в `createIssue` уже даёт подзадачу тем же путём.
- `createDocument` принимает `Ref<Teamspace>`, а не объект - объект внутри не нужен, лишний
  `findOne` в обёртке не нужен тоже. У `createIssue` иначе: там `Project` нужен целиком
  (`identifier`, `sequence`, `defaultIssueStatus`).
- Зависимости: `@hcengineering/text-core` (только `isEmptyMarkup`), НЕ `@hcengineering/text` -
  тот тянет tiptap/prosemirror. `IconProps` - из `@hcengineering/view`, не из core.
- Дубля не свели в чате: `ChatMessageInput.svelte` богаче `postMessage` (черновики, вложения,
  typing, форвард, треды) - сведение регрессировало бы фичи.

## Сделано: этап 1a, вход по ключу и места (TSK-035, 037, 038)

- `loginWithApiKey(key)` в account (обычная операция, токен вызывающего не нужен): хеш -> строка
  секрета -> `isApiKeyUsable` -> промежуточный токен с `extra: { apikey: keyId }` и `exp` 30 минут ->
  прогон через существующий `selectWorkspace`, который и собирает `WorkspaceLoginInfo`. Руками объект
  не собирается. Отказ - всегда `Unauthorized` без деталей.
- `createApiKey` теперь заводит и аккаунт: `createAccount` + `assignWorkspace(role User)`,
  БЕЗ `assertSeatAvailableOnJoin`. `revokeApiKey` снимает членство, person/socialId остаются -
  на них ссылается история задач.
- Место снимается через `LimitsProvider.getIntegrationAccounts` (новый метод) + `seatEligible`.
  НЕ через `getSystemAccounts`: тот обходит весь enforcement (счётные лимиты, неоплату).

### Две ловушки, найденные при ревью агента

- **Исключение из seatSet само по себе ломало фичу.** `tx()` в `seatLimits.ts` шлёт в read-only
  каждого, кого нет в `seatSet`. Интеграционный аккаунт туда не попадает по построению, значит
  ключ не мог бы писать вообще. Нужен явный bypass в `tx()` рядом с `GUEST_ROLES` - снимается
  только seat-деградация, `isSystemAccount` не трогаем. Тест
  `lets an API-key integration account write even with every seat taken`.
- **`publishMembersChanged` не звался** при выпуске/отзыве ключа - seat-логика перестраивает свои
  наборы по members-version, без бампа новый ключ оставался ей неизвестен до рестарта пода.

## Ключ не пускает в UI - проверка на КЛИЕНТЕ, не на сервере

`plugins/workbench-resources/src/connect.ts`, сразу после получения токена: если
`decodeTokenPayload(token).extra?.apikey` задан - `logOut()` и уход на страницу входа.
`decodeTokenPayload` уже есть в `@hcengineering/presentation`, тем же приёмом читает `extra`
`plugins/guest-resources/src/components/Guest.svelte:54`.

**Почему не на сервере.** Первая попытка отклоняла такой токен в `httpServer.on('upgrade')`
(`pods/server/src/server_http.ts`). Это неверно: `api-client` тоже работает по WebSocket, и запрет
убил бы интеграции вместе с UI. Откачено.

`selectWorkspace` (`server/account/src/utils.ts:895`) переносит `extra` из входного токена в
выходной, поэтому проверять достаточно итоговый токен.

Граница честная: это защита от подменённого в local storage токена, а не от того, кто пишет свой
клиент. Настоящая граница прав - `ops`/`spaces`, и она пока НЕ применяется на транзакторе (их
проверяет только webhook-под). По REST и по сокету ключ пишет с правами `User`. Отдельная дыра.

## Права ключа на транзакторе (ApiKeyPermissionsMiddleware)

`loginWithApiKey` кладёт в `extra` рядом с `apikey` ещё `apiops` и `apispaces` (списки через
запятую; пустое поле не кладётся). `selectWorkspace` переносит `extra` как есть, поэтому права
доезжают до сессии. Права протухают вместе с токеном за 30 минут - отдельного отзыва нет.

`foundations/server/packages/middleware/src/apiKeyPermissions.ts`, зарегистрирован в
`server/server-pipeline/src/pipeline.ts` сразу после `GuestPermissionsMiddleware`. Проброс до
middleware: `SessionData.apiKey` (`foundations/core/packages/core/src/server.ts`), заполняется в
`ClientSession` (`foundations/server/packages/server/src/client.ts`) рядом с `permissionsGrantCached`.

**Только записи.** Пустой `ops` -> любая CUD запрещена. Непустой `apispaces` -> запись только в них.

Две ловушки, найденные при ревью:
- **Фильтр ЧТЕНИЯ по spaces ломал фичу и был убран.** `ProjectType`, `TaskType`, статусы, персоны
  лежат ВНЕ пространств проектов, которые перечислены в ключе. `findAll` с `space: {$in: spaces}`
  отрезал их, и `createIssue` падал бы на первом же `findOne(task.class.ProjectType)`. Сужение
  чтения - забота webhook-пода, который знает домен.
- **`core.space.DerivedTx` надо пропускать**, как это делает `GuestPermissionsMiddleware`:
  производные транзакции порождают триггеры, а не ключ, и они уходят в чужие пространства
  (уведомления, активность).

`PermissionsGrant.spaces` переиспользовать нельзя: он вообще не ограничивает чтение (никто не
читает `grant` в `FindSecurityMiddleware`/`SpaceSecurityMiddleware`), а `getLoginInfoByToken`
(`server/account/src/operations.ts:1899`) кидает Forbidden на токен, где заданы и `workspace`, и
`grant` - наш токен всегда workspace-специфичный.

## Webhook-под ходит по REST и ОТ ИМЕНИ КЛЮЧА

`services/webhook/pod-webhook/src/workspaceClient.ts`.

- **REST, не сокет.** `RestClientAdapter implements Client` поверх `createRestClient`: синхронные
  `getHierarchy()`/`getModel()` из один раз загруженной модели, остальное - проброс. Поверх -
  `TxOperations(adapter, socialId)`. Сокет держал бы постоянное соединение и подписку на весь поток
  транзакций воркспейса, а под делает одну операцию и забывает. `uploadMarkup` есть у того же
  `RestClient` - отдельный клиент коллаборатора не нужен.
- **Токен интеграционного аккаунта, а не сервисный.** Первая версия ходила
  `generateToken(systemAccountUuid, ..., { service: 'webhook' })` - это обходило ВЕСЬ enforcement:
  права ключа (нет `extra.apikey` -> middleware молчит), счётные лимиты, режим неоплаты. Ровно то,
  что план запрещает делать через `getSystemAccounts`, только сильнее. Теперь под сам выпускает
  токен `generateToken(personUuid, ws, { apikey, apiops, apispaces })` - той же формы, что
  `loginWithApiKey`; держать их в согласии.
  Ключ в очередь не кладём: job несёт только `keyId`, `personUuid`, `socialId`, `ops`, `spaces`.
- Модель кэшируется по воркспейсу (снимок на время жизни пода), `RestClient` создаётся на задание -
  он несёт токен этого ключа.
- Проверка `spaces` - в consumer, между резолвом человекочитаемого `space` в `Ref<Space>` и записью.
  В HTTP-ручке её сделать нельзя: там ещё строка-идентификатор.

## Операции исполняет ТРАНЗАКТОР, под только проксирует

`POST /api/v1/ops/:operation/:workspaceId` в `pods/server/src/rpc.ts`, реестр и весь резолв ссылок -
`pods/server/src/opsApi.ts` (переехал из пода). Форма ручки - как у соседней `/api/v1/create`:
`withSession` -> `wrapPipeline` -> `new TxOperations(client, primarySocialId)`.

Почему так: модель воркспейса у транзактора уже есть, а под держал её копию на каждый воркспейс
(`RestClientAdapter` + кэш моделей - удалены). Автор транзакций и права ключа получаются даром:
под токеном ключа `primarySocialId` - это интеграционный аккаунт, а `ApiKeyPermissionsMiddleware`
отрабатывает сам, потому что запись идёт через pipeline. Двойной проверки `spaces` больше нет.

`pods/server` уже зависел от `tracker`/`chunter`/`document`/`contact`; пришлось добавить только
`@hcengineering/task` (резолв статуса через `ProjectType`/`TaskType`).

**Markup заливает под**, а не транзактор: у транзактора нет зависимости на collaborator-client и мы
её не заводим. Под зовёт `RestClient.uploadMarkup` (модель для этого не нужна) и шлёт готовый
`Ref<Blob>` в полях `descriptionRef`/`contentRef` - они добавлены в `NewIssue`/`IssueUpdate`/
`NewDocument`/`DocumentUpdateData` рядом с `Markup`. UI-обёртки не тронуты, поля опциональны.

### Дыра, созданная переносом (найдена при ревью, закрыта)

Ручка `/api/v1/ops/*` публичная, и ключ может звать её НАПРЯМУЮ, минуя под. Проверку
«операция входит в `ops` ключа» раньше делал под, а middleware имена операций не смотрит по
замыслу - значит ключ с `ops: ['chat:post']` создавал бы задачи. Теперь ручка сверяет
`:operation` с `extra.apiops` (`isOperationGranted` в `opsApi.ts`, тест на неё же).
Токен без `apiops` - не ключевой, ничего не сужаем.

## Срок жизни токена задаёт владелец (1-90 суток), ротация ручная

`ApiKeySecret.tokenTtlMs` (+ то же поле в account-client), границы `minApiKeyTokenTtlMs` (1 сутки) /
`maxApiKeyTokenTtlMs` (90 суток), дефолт 7 суток. Валидация на сервере в `createApiKey`, не только в
UI. `loginWithApiKey` берёт `secret.tokenTtlMs ?? defaultApiKeyTokenTtlMs`.
НЕ путать с `expiresOn` - это когда перестаёт действовать САМ КЛЮЧ; поля намеренно раздельные.
Автообновления токена нет: истёк - интеграция зовёт `loginWithApiKey` заново.

Лимиты: `apiKeyLimitter` в `sessionManager.checkRate` - 300/30с (~10 rps) против 1500/30с у
обычного пользователя и 5000/30с у системного. В поде: 60/60с для ключа в заголовке, 20/60с для
ключа в пути (URL утекает в логи целиком).

### Дыра с Owner - закрыта

`sessionManager.addSession`: ветка `wsInfo === undefined` (нет членства в воркспейсе) собирала
`wsInfo` с `role: AccountRole.Owner` - она задумана для гостевого и системного аккаунта. А
`revokeApiKey` снимает членство. То есть отозванный ключ с живым токеном становился ВЛАДЕЛЬЦЕМ.
Теперь токен с `extra.apikey` без членства получает `UNAUTHORIZED, terminate: true` до этой ветки.
С 30-минутными токенами это было почти незаметно; с 90-суточными стало бы настоящим.

Перепроверено: `role: AccountRole.Owner` в этой ветке и так был мёртвым полем - `getWorkspace()` его
не читает (только `mode`/`version`/`url`/`dataId`/`progress`/`branding`), а `createSession()` берёт
роль из `info.workspaces[workspace.uuid]?.role` (тот же объект `account.workspaces`, в котором на
этой ветке заведомо нет записи для воркспейса) с фолбэком `AccountRole.User`, и отдельно форсирует
`Owner`/`DocGuest` только по `info.account === systemAccountUuid`/`guestAccount`. Локальный `wsInfo`
в этот путь не попадает вообще. На всякий случай (если поле когда-нибудь начнут читать) заменено на
`AccountRole.ReadOnlyGuest` - самая нижняя роль в `roleOrder`, `GuestPermissionsMiddleware` режет ей
любую запись.

### Отзыв НЕ обрывает активную сессию - открыто

`pods/server/src/rpc.ts:withSession` кэширует сессию по строке токена, `addSession` (а значит и
проверка членства) зовётся один раз на токен. Сессия живёт, пока запросы приходят чаще
`hangSessionTimeoutSeconds` = 60с. `revokeApiKey` шлёт только `publishMembersChanged`, а его слушает
seat-limits, не sessionManager.

Итог: интеграция, дёргающая API чаще раза в минуту, переживёт отзыв ключа до истечения токена -
теперь это до 90 суток. Эскалация до Owner закрыта, но доступ не обрывается.

Готовый путь для починки: `pods/server/src/server.ts` уже потребляет `LimitCategory.Members` и
бампает `membersVersion` - там же можно закрывать/инвалидировать сессии с `extra.apikey`.

## Не сделано в этапе 1

- TSK-007 (UI настроек: `General.svelte:399-409` и `ApiTokenPopup.svelte` закомментированы, ждут расконсервации)
- TSK-008 (письмо владельцу при выпуске/отзыве)
- Аккаунт (`db.account`) и `assignWorkspace` для интеграционного Person не создаются - это этап 1a,
  без них токен по ключу роли в воркспейсе не получит.

## Time-machine (services/worker) - проверена и починена

Тестов не было вовсе. Найдено и исправлено:

- `ctx.error('Error in Time Machine polling loop:')` - объект ошибки НЕ передавался, причина сбоя
  терялась целиком.
- `SendTimeEvent` создавал новый `getPlatformQueue()` (а значит и Kafka-клиент с TCP-соединением)
  на КАЖДОЕ сработавшее событие и не закрывал. Теперь очередь передаётся снаружи, продюсер
  кэшируется `queue.getProducer()`. Добавлен SIGINT/SIGTERM: останов поллинга, `queue.shutdown()`,
  `db.close()` - раньше обработчика не было вообще.
- «отправить все -> удалить все»: сбой одной отправки оставлял в БД всю пачку, включая уже
  доставленные. Теперь per-event try/catch, удаляются только реально отправленные.
- `getExpiredEvents()` без `LIMIT` и без `ORDER BY` - при накоплении вытаскивал всё разом в
  непредсказуемом порядке. Теперь `LIMIT 500` + `ORDER BY target_date ASC`.

Тесты: `services/worker/src/__tests__/{db,worker,db-real,activities}.test.ts`, 55 passed (49 без
реальной БД + 6 db-real; db-real скипается без `WORKER_TEST_DB_URL`). Пакет называется
`@hcengineering/pod-worker`, не `@hcengineering/worker`.

**`removeEvents` намеренно использует `ILIKE`, а не `=`** - это контракт: `services/process`
отменяет таймеры по префиксу (`id: '<execution>_%'`). Помнить при отправке `cancel`: наши `jobId`
вида `wh_<id>` содержат `_`, который в LIKE значит «любой символ» - зафиксировано тестом
(`db.test.ts`/`db-real.test.ts`: `wh_1` cancel также снимает `whX1`). Сейчас webhook-consumer
`cancel` не шлёт, но если начнёт - экранировать `_` и `%`.

### Второй заход: расширение покрытия (2026-09-01)

Добавлено к прошлому: backlog > LIMIT дренится по двум поллам без потерь/переупорядочивания;
повторный `schedule` тем же id переезжает на новый срок (одна строка); `activities.test.ts`
(новый файл) - `SendTimeEvent` берёт продюсер по топику через `queue.getProducer`, не плодит свой
кэш (фейковая очередь имитирует реальное кэширование `PlatformQueueImpl`); `stop()` во время ещё
не завершившегося `pollOnce` не планирует следующий тик (отдельно от уже бывшего теста «стоп после
двух полных полов»); неизвестный `type` в `TimeMachineMessage` - no-op, не падает; `data` (юникод/
числа/`null`, вложенный объект) переживает JSON-круг - для этого фейковый `postgres.Sql` в
`db.test.ts` (`createFakeClient`, экспортирован) стал реально гонять `data` через
`JSON.parse(JSON.stringify(data))` при INSERT, как настоящая `jsonb`-колонка.

**db-real.test.ts прогонялся по-настоящему** - против уже поднятого (не мной) `sanity-postgres-1`
(`postgres:18`, порт 5433, `postgres/postgres`). Схема и имена колонок совпадают с `db.ts`
(`id text, workspace uuid, target_date bigint, topic text, data jsonb`, PK `(id, workspace)`).
Изоляция тестов ок (каждый чистит свои строки; таблица пуста и до, и после прогона). Замечен
хрупкий момент (не баг, не чинил): `getExpiredEvents()` не скоупится по workspace и берёт глобально
старейшие `LIMIT` строк - если прошлый прогон упал до `afterAll` и оставил мусор со старыми
`target_date`, он может закрыть свежие события лимитом. Сейчас мусора нет, тесты новых пунктов
(backlog/ILIKE) на всякий случай сами чистят свой `ws` в начале.

Остаточное: нет метрик и health (не видно размер backlog и отставание), окно redelivery между
send и delete (нужна идемпотентность получателя - у пода она есть через `jobId`), и сервис всё ещё
выключен в проде, а чарт не передаёт `DB_URL`.

## Time-machine + webhook на dev/tests/ws-tests стендах (2026-09-01)

`dev/docker-compose.yaml` и `tests/docker-compose.yaml` уже держали сервис `time-machine`
(image `intabiafusion/worker`) - в `ws-tests/docker-compose.yaml` его не было вовсе, добавлен.
`webhook` (image `intabiafusion/webhook`, `services/webhook/pod-webhook/Dockerfile` уже есть) не
был поднят нигде - добавлен во все три. Оба зарегистрированы в `rush.json`
(`@hcengineering/pod-worker`, `@hcengineering/pod-webhook`).

- Схема `time_machine.delayed_events` создаётся самим сервисом на старте
  (`TimeMachineDB.init` - `CREATE SCHEMA/TABLE IF NOT EXISTS`), отдельной миграции не нужно.
- `POLL_INTERVAL`: не задан в `dev` (дефолт 20с - ок для dev), выставлен `2000` в `tests/` и
  `ws-tests/` - иначе тест на повтор доставки ждал бы 20 секунд.
- `webhook` не трогает БД сам - только `SECRET`, `ACCOUNTS_URL` (обязательны, иначе падает при
  старте), `PORT` (умолчание 4043), `QUEUE_CONFIG`/`QUEUE_REGION`. Retry-сообщения шлёт в
  `QueueTopic.TimeMachine`, топик не создаёт сам (это топик time-machine).
  Зависит от `redpanda`+`account`, от `postgres`/`time-machine` - нет (не жёсткая стартовая
  зависимость, kafka создаёт топик лениво).
- Наружу оба идут через nginx по образцу `billing`/`payment` (path-роутинг, не host-порт):
  добавлен upstream + `location /_webhook` в `dev/nginx.conf`, `tests/nginx.conf`,
  `ws-tests/nginx.conf`. Изнутри compose-сети - `webhook:4043`.
- Документация по подъёму/проверке - `dev/readme.md` и `tests/readme.md` (разделы
  "Time-machine + webhook"). У `ws-tests/` своего readme нет ни у одного сервиса - решения не
  плодить его специально ради двух сервисов, конфигурация самодокументирована env-комментариями
  в `docker-compose.yaml`.
- Сборку `rush fast-build:docker-build --to @hcengineering/pod-worker --to @hcengineering/pod-webhook`
  не гонял (параллельно другие агенты правят исходники обоих пакетов + `server/account`,
  `foundations/server`, `pods/server` - сборка сейчас захватила бы нестабильное состояние).
  `docker compose config` и `nginx -t` (синтаксис, без реального DNS) прошли на всех трёх стендах.
