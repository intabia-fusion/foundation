# pod-webhook: outgoing delivery

TSK-2026-09-01-023..028,058,060,061 + follow-ups. Тот же под, что и входящая сторона
(`services/webhook/pod-webhook`), второй consumer (`src/delivery.ts`) на
`QueueTopic.WebhookDelivery`. Смежное: [webhook_ingest_pod](webhook_ingest_pod.md),
[webhook_api_keys](webhook_api_keys.md).

## Модель - `plugins/setting`/`models/setting`, не account-client

`setting.class.WebhookEndpoint` (`TWebhookEndpoint`, `DOMAIN_SETTING`, space `core.space.Workspace`,
конвенция та же, что у `Integration`):
`url/events/spaces?/secrets/enabled/failureCount/lastDeliveryOn?/lastError?`. Это workspace-данные,
в отличие от API-ключей (`IntegrationSecret` в account DB - control-plane identity). `models/all`
уже подключает `createModel` из `models/setting` в каждый воркспейс, миграция не нужна.

## Контракт очереди

`WebhookDeliveryMessage` (`src/types.ts`): `{deliveryId, workspace, endpointId, event, attempt}`.
`webhookId`/`webhookTimestamp` добавляет delivery-worker прямо перед подписью, не продюсер: ретраю
нужен свежий timestamp (5-минутное replay-окно получателя), но тот же id (идемпотентность), и только
worker знает, какая это попытка. Одно сообщение = одна пара (получатель, событие); фан-аут по
подписчикам - работа translator.

## Подпись (`src/signature.ts`)

- Только **Standard Webhooks**. Схемы slack/github были написаны и **отменены**
  (TSK-2026-09-01-058) как лишний словарь без спроса.
- Формат секрета `whsec_<base64(32 байта)>`, HMAC-ключ = base64-декодированные байты после префикса.
  Подписывается `{webhook-id}.{webhook-timestamp}.{body}`, HMAC-SHA256.
- Заголовки: `webhook-id`, `webhook-timestamp` (Unix сек), `webhook-signature` (значения
  `v1,<base64>` через пробел), плюс `X-Webhook-Delivery-Id`/`X-Webhook-Attempt` (TSK-060,
  Atlassian-style - у Standard Webhooks своих нет).
- Ротация: `secrets: WebhookSecretEntry[]`, до 2 активных, подписываются ВСЕ сразу - это и есть
  механизм ротации Standard Webhooks.
- **Подпись при нуле секретов кидает**: пустое значение заголовка нестрогий получатель может счесть
  проверенным.
- `generateWebhookSecret` живёт в `@hcengineering/setting` (`plugins/setting/src/webhookSecret.ts`),
  `signature.ts` его ре-экспортирует: браузер (создание/ротация секрета) не может импортировать
  под-деплойабл. Написан на Web Crypto (`crypto.getRandomValues`+`btoa`), а не
  `crypto.randomBytes`/`Buffer` - старая реализация была Node-only и не собралась бы для браузера.

## SSRF (`src/ssrf.ts`)

- Только `https`; `http` - лишь под `ALLOW_INSECURE_WEBHOOK_HTTP` (стенд).
- Блокируются v4: `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 100.64/10, 224/4`; v6: `::1,
  ::, fc00::/7, fe80::/10` + IPv4-mapped в обеих формах (`::ffff:127.0.0.1` и `::ffff:7f00:1`) -
  иначе литеральный адрес проносит блокированную цель мимо v4-проверки.
- Имена, которые не поднять никакой настройкой: `localhost, metadata.google.internal, metadata,
  cluster.local, internal, local` + суффиксы `.svc.cluster.local, .cluster.local, .internal, .local`
  (совпадение по границе точки, `notinternal.com` не ловится). `DEV_ALLOWED_WEBHOOK_HOSTS` снимает
  только диапазоны, имена - никогда. `BLOCKED_WEBHOOK_HOSTS` добавляет свои имена поверх встроенных.
- Две проверки: `resolveAll`+`assertAllowed` перед сборкой запроса (fail fast) и свой `lookup` на
  `http(s).request`, который перерезолвит и перепроверит прямо перед открытием сокета (защита от DNS
  rebinding - два резолва могут ответить по-разному). Проверяются ВСЕ адреса, не первый. Обе идут
  через `ssrfPolicy.assertAllowed` - мутабельная косвенность существует только чтобы тесты могли
  подменить connect-time проверку (тестам таймаута/редиректа/лимита размера нужен реальный локальный
  сервер на 127.0.0.1, а его настоящая политика блокирует безусловно).
- `lookup` обязан вернуть массив при `options.all === true` (квирк Node 20 `autoSelectFamily`).
- Битый URL -> `SsrfError`, не `TypeError`: иначе ретраился бы как временная ошибка.
- Редиректы не следуются: `http.request`/`https.request` сами этого не делают (в отличие от
  `fetch`), 3xx возвращается как любой другой статус.

## Retry / disable

- Ретраится: `408/409/425/429` + любой `5xx` + сетевые/таймаут. Всё прочее (другие 4xx, 3xx,
  `SsrfError`) - постоянная ошибка.
- Backoff в `src/retry.ts` (`scheduleRetry`/`backoffDelayMs`, `MAX_ATTEMPTS=5`), общий с входящим
  consumer: `30с * 2^attempt` с потолком 10 мин -> 30с/1м/2м/4м/8м. Своего планировщика ни у одного
  consumer нет - следующая попытка уходит в time-machine (состояние переживает рестарт пода).
- `failureCount` - НЕ счётчик попыток внутри доставки (это `job.attempt`), а подряд идущие
  **финальные** отказы по РАЗНЫМ доставкам; сбрасывается на любом 2xx. Порог
  `Config.WebhookDisableAfterFailures` (3) -> endpoint выключается + письмо владельцу. Порог
  проверяется перечитыванием документа после `$inc` (иначе гонка параллельных доставок). Выбрано
  вместо "выключить, когда исчерпаны ретраи одного события", чтобы одно плохое событие не убивало
  здоровый endpoint - как у GitHub/Stripe.

## Уведомление владельца (`src/notify.ts`)

Первая версия резолвила `modifiedBy` эндпоинта через `contact.class.SocialIdentity` воркспейса по
REST - потому что все подходящие методы account-client закрыты: `getWorkspaceMembersInfo` за
`checkAdminRead`, `getAccountInfo` пускает только сервисы `workspace`/`tool`,
`getWorkspaceMembers()` требует роли в воркспейсе (у системного токена её нет).

Сейчас в account заведён свой метод `getWorkspaceOwnerEmails(workspace)`
(`server/account/src/operations.ts:3296`, RPC в account-client), им же пользуются письма о
выпуске/отзыве ключа. `notifyOwnerDisabled` шлёт по одному `EmailNotification` на владельца в
`QueueTopic.NotificationQueue` (`{type:'email', data:{to,subject,text,html}}`) - тот же ad-hoc
продюсер, что у billing/crm/gmail-resources (общего пакета нет; consumer `pod-mail` смотрит только
на форму). Best-effort: ошибки логируются, наружу не кидаются.

## `getSystemTransactorTarget` (`src/workspaceClient.ts`)

`getTransactorTarget` отрефакторен так, чтобы делить кэш endpoint'ов и сборку REST-клиента с
системным вариантом: `generateToken(systemAccountUuid, workspace, {service:'webhook'})`. Действует
как платформа (полный доступ к своим `WebhookEndpoint`), а не как интеграция - за доставкой нет
API-ключа, олицетворять некого.

## Транзакции -> события (TSK-059/062/064/065)

`src/eventTable.ts` (таблица правил) + `src/txTranslator.ts` (batch-consumer, схлопывание, диспатч),
тип `WebhookEvent` в `src/types.ts`.

**Где лежит таблица.** Рядом с `src/operations.ts` входящей стороны - оба описывают один домен.
Реестр-исполнитель уехал в `pods/server/src/opsApi.ts`, но это деплойабл, webhook не может зависеть
от него как от библиотеки. pod-webhook - единственное место, где уже говорят на обоих словарях
(валидирует входящие action по `apiKeyOperations`, читает сырой tx-поток).

**8 типов событий** (`webhookEventTypes` в `plugins/setting` - общий источник для чекбоксов UI и
`domainRules`): `issue.created`, `issue.status_changed`, `issue.assigned`, `issue.commented`,
`issue.time_reported`, `issue.time_report_updated`, `message.posted`, `document.created`.
`DomainRule.type` типизирован как `WebhookEventType`, а не `string` - 7-й тип в `eventTable.ts` без
записи в общем списке не скомпилируется, разъехаться они не могут. Цена: `txTranslator.test.ts`
тестирует remove-схлопывание синтетическим `'issue.removed'` и требует явный `as WebhookEventType` в
двух местах.

**`updatedFrom` без "before" в Tx.** Подтверждено чтением `TxUpdateDoc.operations:
DocumentUpdate<T>` (`tx.ts:295-308`) и `QueueMiddleware`
(`foundations/server/packages/middleware/src/queue.ts`): в `QueueTopic.Tx` едут только НОВЫЕ
значения, никогда старые - это верно для всех потребителей топика (fulltext, activity,
notifications, ai-bot, love), не webhook-специфичная дыра. `services/activity/src/cache.ts`
(`WsCache`) решает ту же задачу in-process `Map<objectId, Doc>` с REST-фолбэком на промах.

Зеркалим меньшей копией: `ObjectCache = Map<"workspace:objectId", Record<field, value>>` только по
отслеживаемым правилами полям (не полный Doc - наши поля всегда плоские `Partial<Data<T>>`,
`operations[field]` уже И ЕСТЬ новое значение, replay через `TxProcessor` не нужен). Заполняется на
`create`, читается-и-перезаписывается на `update`, дропается на `remove`. **Цена прямым текстом:**
REST-фолбэка нет - рестарт пода, ребаланс consumer-группы или первый увиденный update по объекту,
созданному до старта, дают `updatedFrom` = `{}` (ключ опущен, не выдуман) один раз, дальше точно.
Настоящая починка требует персистентного снапшота или API истории по полю - ни того, ни другого нет
(открытый хвост TSK-2026-09-01-080). Потолок 50k записей (мягкий, вытеснение по порядку вставки, не
LRU).

**Батчинг.** `queue.createBatchConsumer<Tx>(QueueTopic.Tx, ...)` (тот же примитив, что
`pods/fulltext/src/manager.ts` на том же топике), `batchSize: 200`. Группировка workspace -> space
-> objectId вложенными `Map` в порядке первого появления (`Map` итерируется по вставке) - именно на
этом держится "разные объекты не схлопываются, порядок внутри space сохранён", отдельного индекса не
нужно. `TxMixin` отсекается на фильтре группировки (правил на миксины нет, а `operations` у миксина
отсутствует - update-схлопывание бы упало). `core.space.DerivedTx` дропается тем же однострочником,
что в `services/activity/src/worker.ts`.

**Схлопывание - по паре (объект, сработавшее правило), не по объекту.** В плане таблица ("несколько
update -> один update") читается на уровне объекта, но среди шести именованных событий два разных
update-факта на одном классе (`issue.status_changed`, `issue.assigned`) - схлопывание "сменили
исполнителя, потом статус" в одно событие молча потеряло бы одно из них для подписчика на один тип.
Сделано: внутри update-прогона группируются затронутые поля, одно событие на каждое отдельное поле
(повторные записи в ТО ЖЕ поле схлопываются, `data` от последней, `updatedFrom` - значение из кэша
до первого касания в прогоне). create-then-update по-прежнему схлопывается в один `create` (никакого
"before" нет - объекта не существовало). Прогон, заканчивающийся `remove`, схлопывается в `remove`
независимо от предыстории (обобщение "update+remove -> remove" ещё и на ведущий create).

**Получатели.** Один `findAll(setting.class.WebhookEndpoint, {enabled:true})` на воркспейс на батч
(не на событие) через `getSystemTransactorTarget`, дальше фильтр в процессе по
`endpoint.events.includes(type)`; `enabled` перепроверяется и клиентски (defense in depth). По
одному `WebhookDeliveryMessage` на пару (событие, endpoint), `attempt: 0`, один `producer.send` на
воркспейс.

**Приватные пространства.** Вместе с endpoint'ами кэшируется список приватных space
(`findAll(core.class.Space, {private:true})`, TTL 60с). `endpointSeesSpace`: непустой whitelist -
только перечисленное; пустой = "все НЕприватные", никогда "всё". Причина: endpoint настраивает
Owner, который не состоит в каждом приватном пространстве.

## Иерархия классов в матчинге правил

`domainRules` написаны против базовых классов. `txTranslator.ts` резолвит `objectClass` каждой tx к
предку из таблицы через `resolveClassesForBatch` (async, I/O), вызываемый раз на батч **до**
`buildEventsForBatch` (та остаётся чистой/синхронной - тесты зовут её без моков). Результат (в т.ч.
отрицательный) пишется в `ClassResolutionCache` (`Map<"workspace:classRef", Ref<Class<Doc>> |
null>`), которую `buildEventsForBatch` только читает.

**Почему `findAll(core.class.Class, {}, {projection:{_id:1,extends:1}})`, а не `getModel()`.**
Class/mixin-документы лежат в `DOMAIN_MODEL` и запрашиваются тем же `/api/v1/find-all`, что любой
домен. `getModel()` вместо этого проигрывает всю tx-историю воркспейса на клиенте, восстанавливая
`Hierarchy`/`ModelDb` - ровно та per-workspace загрузка модели, которой этот под избегает.
Классов+миксинов на всю платформу ~450; `targetClass` кастомного task-типа - настоящий
`core.class.Class` (`plugins/task/src/utils.ts` создаёт его через `createDoc(core.class.Class, ...,
{extends: data.ofClass})`, `task.mixin.TaskTypeClass` - метаданные поверх, не другой `_class`), так
что bulk-fetch видит его напрямую.

**Кэш - чистая мемоизация без TTL.** Class ref не переиспользуется (target-классы task-типов -
`${taskId}:type:mixin`), создание класса строго предшествует любой tx документа этого класса. Раз
разрешённое (положительно ИЛИ отрицательно) не перерешается. Потолок 20k (то же вытеснение по
вставке, `capCache` обобщён на любой кэш). Полная таблица классов воркспейса тянется раз на батч с
нерезолвнутыми классами, а не на класс.

**Отказ ведёт себя как `dispatch`**: недоступность транзактора в `resolveClassesForBatch` логируется
и пробрасывается (не глотается), чтобы `createBatchConsumer` передоставил батч, а не потерял
события.

`attachedToClass` (сужение create-правила по вложению, комментарий-на-Issue vs
комментарий-на-Channel) остаётся точным совпадением - комментарий к задаче кастомного типа
`issue.commented` не даст. Тот же класс дыры, однострочный follow-up на том же кэше.

## Обогащение тела события (`src/enrich.ts`, `src/links.ts`)

`WebhookEvent` отдаётся Linear-подобным: `action, type, actor, actorUrl, data, updatedFrom, url,
webhookId, webhookTimestamp, organizationId`.

- `enrich.ts` резолвит сырые ref в те же имена, которые `/api/v1/ops` принимает НА ВХОД: персона ->
  email, статус -> имя, приоритет -> `PRIORITY_NAMES` (те же, что `opsApi.ts`), чтобы получатель мог
  вернуть обратно то, что получил. Промахи остаются нерезолвнутыми, а не угадываются. Кэш
  `EnrichCache` (statusNames/personEmails/socialIdPersons/spaces/issueIdentifiers) - in-memory, ≤20k
  записей на вид.
- `links.ts` строит `url`/`actorUrl` из `FRONT_URL` + `workspaceUrl`:
  `/workbench/<ws>/tracker/<identifier>`, `/document/<slug>-<id>`, `/chunter/<id>|<class>`,
  `/contact/<id>`. Пути повторяют то, что делают серверные UrlPresenter-миксины
  (`server-plugins/*-resources`) - переписаны, а не переиспользованы: тем нужна загруженная модель и
  `Hierarchy`. Пустой `FRONT_URL` -> `undefined`, поле просто не едет.

## История доставок и тестовая отправка (TSK-029/030)

**`setting.class.WebhookDelivery`** (`plugins/setting`, `models/setting`, `DOMAIN_SETTING`) - один
документ на ЗАВЕРШЁННУЮ доставку (2xx или исчерпанные ретраи), не на попытку:
`recordDeliveryOutcome` (экспорт из `delivery.ts`) добавляет один `createDoc` ровно там, где уже
есть `updateDoc` в `onSuccess`/`finalizeFailure`. Потолок 20 на endpoint: `findAll` sort `createdOn`
desc limit 21, удалить 21-й если есть - максимум один лишний `removeDoc` на запись, отдельного sweep
нет. Намеренно НЕ источник истины о здоровье endpoint (это `failureCount`/`lastError`/`enabled`) -
тестовая отправка пишет историю, но их не трогает.

**Тестовая отправка - своя ручка, не очередь.** `POST /api/v1/webhook/:workspace/test/:endpointId` в
`server.ts`, аутентификация session-токеном (`decodeToken` из `@hcengineering/server-token` + сверка
`decoded.workspace === params.workspace`) - тот же уровень доверия, что у прямых вызовов пода из
`Backup.svelte`; серверной проверки роли нет, категория настроек уже Owner-gated в модели.
Синхронная: зовёт те же `buildDeliveryHeaders`/`safeFetch`, что `processDelivery`, и возвращает
HTTP-результат в теле ответа - тест обязан показать свой результат, круг через очередь был бы лишней
сложностью. Без ретраев и без влияния на `failureCount`/`enabled`, но попытка пишется в историю
(отличима по `test_`-префиксу `deliveryId`).

## Счётчики - `WebhookStat`

Один сателлит-документ на `(direction, target, type)` (`setting.class.WebhookStat`, DOMAIN_SETTING),
а не поле `Record<type, number>`: `$inc` (`operator.ts`) пишет только плоские числовые свойства
верхнего уровня, map-поле требовало бы read-modify-write и теряло инкременты при параллельных
доставках. `_id` детерминированный (`${direction}:${target}:${type}`,
`src/stats.ts::bumpWebhookStat`): direction/target не содержат `:` (target - `randomUUID()` keyId
или `generateId()` endpoint), так что склейка бесконфликтна, хотя `type` двоеточие содержит
(`issue:create`). SQL UPDATE по отсутствующей строке - молчаливый no-op (postgres-адаптер
`txUpdateDoc`), поэтому существование проверяется `findOne`, а гонка первой записи - ловлей
duplicate-key на `createDoc` проигравшего с фолбэком в тот же `$inc`. Outgoing бампает `(out,
endpoint._id, event.type)` один раз на терминальный исход из `onSuccess`/`finalizeFailure`, никогда
из `retryOrFinalize`. `bumpWebhookStat` не кидает (логирует и глотает) - счётчик не должен ломать
доставку.

## UI настроек

`setting.ids.Webhooks`/`component.Webhooks` в `plugins/setting` (нужны модельной категории, `role:
AccountRole.Owner`, рядом с `apiKeys`); всё UI-локальное - в
`plugins/setting-resources/src/plugin.ts` (тот же merged `setting` plugin id, что у строк ApiKeys -
один lang-namespace).

Два компонента, а не три как у ApiKeys: `WebhooksSettings.svelte` (список, `createQuery` на
`WebhookEndpoint`) + `WebhookEndpointPopup.svelte` (create И edit И секреты И история И
тест-отправка в одном `Modal` - `okAction` в этом `Modal` не закрывает автоматически, поэтому
"создали и сразу показали секрет" это просто "переключили `endpoint` с undefined на созданный
документ, окно не закрываем"). Отличие от ApiKeys намеренное: секрет вебхука должен оставаться
извлекаемым после создания (получателю он может понадобиться снова) - маскирован по умолчанию, с
пер-секретным раскрытием, а не одноразовый показ.

**`WebhookServiceUrl`** повторяет паттерн `BackupUrl` (`setting.metadata.*` +
`getMetadata(presentation.metadata.Token)` как bearer, браузер ходит в под напрямую, без
транзактора), проведён через те же 6 файлов: `pods/front/src/__start.ts`, `dev/prod/src/platform.ts`
(+types), `desktop/src/ui/platform.ts`/`types.ts`, `dev/prod/public/config-dev.json`.
`dev/nginx.conf` уже имел `location /_webhook` - менять nginx не пришлось. У `front` в
docker-compose появился `WEBHOOK_SERVICE_URL` - имя намеренно отличается от несвязанного
существующего `WEBHOOK_URL` (фича love и env самого webhook-mock).
