# Память транзактора на пространство

Замеры от 2026-08-11, model.json = 3688 tx (2799 TxCreateDoc, 889 TxMixin), 1.9 Mb на диске.

## Изолированный замер (N копий структур в одном процессе, heap после двойного GC)

| компонент | Mb на ws |
|---|---|
| `Hierarchy` | 0.63 |
| `ModelDb` | 1.48 (docs 0.95 + индексы `objectById`/`objectsByClass` 0.44) |
| полный `createServerPipeline` (маржинально, 20 копий против живой БД) | 2.33 |

Модель + hierarchy = ~91% стоимости ws. Распарсенный `model.json` = 5 Mb, общий на процесс.

## Живой транзактор

| | sanity, 0 ws | прод, 19 ws | sanity, 95 ws |
|---|---|---|---|
| heapUsed | 95 Mb | 130 Mb | 390 Mb |
| RSS | 268 Mb | 461 Mb | 622 Mb |

Цена ws по heap: (390 - 95) / 95 = ~3.1 Mb, на проде (130 - 95) / 19 = ~1.8 Mb. Сходится с изолированным
замером плюс сессии.

На проде 253 Mb из 461 Mb RSS - вне V8 heap (native-буферы, pg-пул `max:100`, фрагментация jemalloc).
Это не масштабируется с числом ws и на малом числе пространств доминирует над моделью.

## Heap snapshot живого транзактора (102 ws, heapUsed 395 Mb)

Снят без рестарта: `kill -USR1 1` в контейнере -> CDP `Runtime.evaluate` с
`process.mainModule.require('v8').writeHeapSnapshot(...)` (голый `require` и динамический `import`
в evaluate недоступны). Retained считался как reachable(группа) минус reachable(корни в обход группы).

| потребитель | retained | доля heap | на ws |
|---|---|---|---|
| `ModelDb` | 148.9 Mb | 38% | 1.46 |
| `Hierarchy` | 65.6 Mb | 17% | 0.64 |
| остальное per-ws (37 middleware, адаптеры, метрики, сессии) | ~6 Mb | 1.5% | 0.06 |
| baseline процесса | ~175 Mb | 44% | - |

`ModelDb` 206 инстансов на 102 ws - второй принадлежит `InMemoryAdapter` (mem.ts) для транзиентного
домена и почти пустой, дублирования модели нет.

## Сделано: ModelDb владеет документами, Hierarchy их индексирует

Было: `Hierarchy.tx()` и `ModelDb.addTxes()` независимо десериализовали одни и те же документы
классов и атрибутов - 44% модели лежало в двух копиях.

Стало (`memdb.ts`, `hierarchy.ts`):
- `ModelDb.addTxes` материализует документ один раз и передаёт инстанс в `hierarchy.tx(tx, doc)`;
  `classifiers`/`attributesById` держат ссылки. Обновления применяет только владелец - `Hierarchy`
  пропускает их для инстансов из `externallyOwned`, иначе `$push`/`$inc` применились бы дважды.
- `addTxes` работает в две фазы: сначала материализация, потом индексация по классам. Индексу нужна
  полная цепочка предков, а документ может встретиться раньше своего класса (254 таких в модели).
- `ancestors`/`descendants`/`inheritedDomains` выводятся лениво с кэшем. Инвалидация грубая:
  любой create/update/remove классификатора (и CoW через `ownClassifier`) сбрасывает все три кэша
  (`invalidateChains`). Пересчёт `getDescendants(Doc)` после сброса ~300 us на реальной модели.
- `ModelMiddleware.init` больше не гоняет отдельный проход `hierarchy.tx` - его делает `addTxes`.
  Проход остаётся только когда задан `filter` (ему нужна готовая иерархия).

Побочно починен баг: 15 классов (все наследники `preference:class:Preference`, который
регистрируется в `models/all` позже них) имели оборванную цепочку предков - `ancestors` считались
жадно в момент создания класса и никогда не пересчитывались. `isDerived(SavedMessage, core.class.Doc)`
возвращал `false`, классы выпадали из `getDescendants(core.class.Doc)`, то есть из обхода индексера
(`server/indexer/src/indexer/indexer.ts:205`), правил приватности (`middleware/src/private.ts:123`) и
не находились в `ModelDb` по базовому классу.

### Бенчмарк (`models/all`, `BENCH=1 NODE_OPTIONS=--expose-gc npx jest model.bench`)

| метрика | до | после |
|---|---|---|
| память на ws | 2.36 Mb | 1.80 Mb (-24%) |
| полный билд ws | 23.2 ms | 17.0 ms (-27%) |
| `isDerived` | 52.9 ns | 43.3 ns |
| `findAllSync(Attribute)` | 44.0 us | 37.2 us |
| `ModelDb.addTxes` | 15.3 ms | 17.2 ms (+12%, компенсируется убранным вторым проходом) |

## Что можно шарить

Системная часть модели идентична у всех ws. Собственных model-tx мало (sanity-ws 151, meetings-ws 52
против 3688 системных), но пустых нет ни у одного - при создании ws появляются свои `core:class:Class`
и `Mixin` (TaskType/ProjectType). Значит "если user tx пусто - берём shared" не сработает, нужен CoW:
общий `Hierarchy` + `ModelDb`, per-ws overlay (own Map -> parent Map). Оценка: 2.1 Mb -> ~0.4 Mb на ws.
Окупается примерно от 200 ws на под; ниже этого выигрыш меньше baseline процесса.

## Замер heap-дельты на cold build врёт

Дельта `heapUsed` вокруг построения pipeline завышает в ~3.4 раза (794 Mb суммой против 390 Mb
фактического heap на 95 ws) - в неё попадает временный мусор построения, который потом собирает GC.
Честное число даёт только (heapUsed - baseline) / число ws.

## Инварианты copy-on-write над shared-моделью

Любая правка воркспейса над документом системной модели идёт через copy-on-write. Пробы показали
четыре способа испортить общую модель, все были реальны до фиксов:

- **Поверхностная копия.** `{ ...doc }` в `MemDb.ownDoc`/`Hierarchy.ownClassifier` оставляет вложенные
  объекты и массивы общими с родителем. Утекали: `$push`/`$pull` над массивом, dotted `$set`
  (`type._class`), и `updateMixin` над классом, у которого миксин уже есть. Последнее - живой путь:
  `models/card/src/index.ts` вешает `core.mixin.VersionableClass` на `card.class.Card`, а
  `VersioningSetting.svelte` его обновляет. Лечится `clone()` из `core/src/clone.ts`.
- **`Object.freeze` поверхностный.** Верхний уровень защищал, вложенные объекты - нет. `MemDb.freeze()`
  теперь морозит рекурсивно (2796 доков реальной модели - 5.3 ms разово на старте пода).
- **Двойное применение операторов.** `ownDoc` кладёт копию в иерархию через `replaceDoc`, но не
  регистрировал её в `externallyOwned`, поэтому `Hierarchy.txUpdateDoc` применял `$push` второй раз.
- **Удалённый атрибут оставался видимым.** `ownAttributesOf` мержит родительскую мапу по имени и не
  смотрел в `removed`: `ModelDb` документ прятал, `getAllAttributes`/`findAttribute` - показывали.

Стоимость COW (реальная модель, ns на документ): spread 775, `clone` 3715, `structuredClone` 2643,
`clone` атрибута 1892. Путь холодный - воркспейс копирует единицы документов за всё время жизни,
поэтому immer (structural sharing + deep auto-freeze) не окупает новую зависимость в `core`, а
Proxy-обёртка на чтении била бы по самому горячему пути (`isDerived`, `getAllAttributes`).

Регрессии ловят: `foundations/core/.../__tests__/sharedModel.test.ts` (11 сценариев UI-операций) и
`models/all/src/__tests__/sharedModel.test.ts` (те же операции над реальной моделью). Инвариант один -
снапшот shared-модели до и после операций воркспейса совпадает.

## Фактическая экономия (BENCH=1 NODE_OPTIONS=--expose-gc, `models/all`)

`standalone 1.78 Mb/ws, shared model 2.23 Mb once + 0.00 Mb/ws` - пустой оверлей стоит только своих
пустых Map, реальный воркспейс добавляет ровно свою дельту model-транзакций. Порог окупаемости - два
воркспейса на под.

Harness бенчмарков переехал из `server-middleware/src/tests/bench/bench.ts` в
`@hcengineering/measurements` (`src/bench.ts`), оттуда его берут и middleware, и `models/all`. Пакет
изоморфный, поэтому `process`/`gc` в harness читаются через `globalThis`, а не через `@types/node`.

Покрытие `hierarchy.ts` и `memdb.ts` тестами - 100% по строкам, веткам и функциям.

## Ревью 2026-08-16: неочевидные ловушки overlay-модели

- **`describe` в `measurements/src/bench.ts`.** `index.ts` реэкспортирует bench, `describeBench` берёт
  jest-глобал при загрузке модуля -> `require('@hcengineering/core')` вне jest падает
  (`ReferenceError: describe is not defined`). Лечится ленивым обращением к `describe`.
- **Двухфазный `addTxes` и create+remove в одном батче.** Фаза 2 индексирует `created[]` целиком,
  `delDoc` внутри батча уже удалил документ из `objectById` -> зомби в `objectsByClass`
  (`findAll` видит, `findObject` нет). Реальный вход: `ModelMiddleware.init` грузит всю историю
  model-tx воркспейса одним батчем. Индексировать только `objectById.get(id) === doc`.
- **Порядок `addTxes` -> `hierarchy.tx` (services/activity, services/notifications).** Повторный
  `hierarchy.tx(create)` без инстанса подменяет ModelDb-документ своей копией, но id остаётся в
  `externallyOwned` -> все последующие update/mixin иерархия пропускает. В `txCreateDoc` без `doc`
  нужно `externallyOwned.delete`.
- **`Object.freeze` + mixin Proxy.** Инвариант Proxy `get`: для non-writable non-configurable
  свойства target трап обязан вернуть то же значение. Замороженный shared-документ + миксин с ключом,
  совпадающим с корневым (`server-notification:mixin:TypeMatch.match` на 3 `NotificationType`) ->
  `TypeError` при чтении через `hierarchy.as`. Сегодня читатель (services/notifications) строит
  свою незамороженную модель, но `findAllSync(mixin)` в транзакторе на shared-модели упадёт.
- **Overlay-кэши.** Дочерний `Hierarchy` дублирует цепочки предков/потомков родителя (~0.22 Mb/ws
  после прогрева); `ownAttributesOf` при `removed.size > 0` или own-атрибуте класса аллоцирует Map
  на каждый вызов (findAttribute x4-40). Родитель после `freeze` неизменяем, поэтому дочерний
  может делегировать цепочки родителю и держать полную own-map атрибутов класса.

## Где ещё строили иерархию из транзакций (обход 2026-08-16)

`ModelDb.addTxes` сам кормит иерархию, поэтому отдельный проход `hierarchy.tx` убран:
`core/src/client.ts` (`buildModel`, он же путь `api-client` REST), `server/tool/src/index.ts`,
конструкторы `services/activity|notifications/src/worker.ts` и `services/rating/src/manager.ts`,
рантайм-путь `services/activity|notifications/src/workspace.ts` (там `hierarchy.tx` после
`addTxes` ещё и подменял инстанс, см. `externallyOwned`).

Проход остаётся законным в трёх местах:
- `ModelMiddleware.init` и `pods/fulltext|services/rating` — фильтру нужна полная иерархия до того,
  как из ModelDb выкинут документы;
- `dev/tool/src/mdiff.ts` — `model.tx` индексирует по классам, поэтому иерархия должна быть готова
  целиком (в ветке был интерливинг, из-за него документы, встреченные раньше своего класса,
  падали в `dropTx`);
- `server/indexer` и `client.ts` рантайм — там пара `hierarchy.tx` + `model.tx`, а `model.tx`
  (в отличие от `addTxes`) иерархию не трогает, двойного применения нет.

`services/rating` переведён на общую модель по образцу `pods/fulltext`: `sysModel` теперь
отфильтрованный `fulltextModelFilter` и замороженный, калькуляторы работают оверлеем
(`new Hierarchy(sysHierarchy)` + `new ModelDb(hierarchy, sysModel)`, `systemModelShared = true`).
Аргументы `sharedHierarchy`/`sharedModel` в `RatingCalculator.create` опциональны - `dev/tool`
запускает разовый расчёт без общей модели.

Не трогали: `services/export` и `server/workspace-service` строят пайплайн на один воркспейс за
запуск, общая модель там дороже выигрыша. `foundations/core/packages/model/src/dsl.ts` - это
сборка модели, а не воркспейс. Осталось известное дублирование: `services/activity|notifications`
берут готовые `hierarchy`/`modelDb` из `client.getModel()`, а `ModelMiddleware.init` строит модель
в них повторно из `txAdapter` (корректно, но вдвое дороже).

## Что поймал freeze() на живом стенде (2026-08-16)

Заморозка shared-модели вскрыла четыре места, которые молча правили документ модели. До shared-модели
это была порча одной копии на процесс, теперь - утечка между воркспейсами.

- **`server-core/src/triggers.ts`** - `Triggers.addDerived` разворачивал `txMatch` (`objectClass` ->
  `$in: [class, ...descendants]`) прямо в документе `serverCore.class.Trigger`, взятом через
  `findAllSync`. Это и был `TypeError: Cannot assign to read only property 'objectClass'`, из-за
  которого на стенде падал каждый пользовательский tx. `Triggers` создаётся на воркспейс, документ -
  общий, так что descendants первого воркспейса протекали бы во все остальные. Лечится `clone(match)`
  в `addTrigger`.
- **`middleware/src/spacePermissions.ts`** - `targetRole.permissions = updateTx.operations.permissions`
  над `Role` из `findAllSync`. Права роли одного воркспейса протекали бы в соседние.
- **`server-plugins/process-resources/src/index.ts`** - `syncContext` писал `_process.context[...]`
  в `Process` (DOMAIN_MODEL), взятый через `control.modelDb.findObject`.
- **`mongo/src/storage.ts`** - `fillLookup`/`fillReverseLookup` клали инстанс из `findAllSync` прямо в
  `$lookup`, а вложенный lookup потом пишет `$lookup` уже в него. В postgres-адаптере это чинили
  раньше (`clone`, FUSIO #167), в mongo - нет.

Обход остального кода (`foundations/server`, `server`, `pods`, `server-plugins`, `services`, ~140
мест доступа к модели) других мутаций не нашёл. Отдельно проверены 267 вызовов
`getDescendants`/`getAncestors`: в продовом коде массив нигде не мутируется, только читается или
копируется - это важно, потому что дочерняя иерархия отдаёт массив родителя как есть.

## Ещё два места, найденные прогоном стенда

- **`DomainFindMiddleware.findAll`** для `DOMAIN_MODEL` отдавал `modelDb.findAllSync` - живой инстанс
  модели, без клона (в отличие от `ModelMiddleware.findAll`, который зовёт клонирующий `findAll`).
  Этот middleware стоит раньше в цепочке, поэтому любой серверный `client.findAll` по model-классу
  получал документ общей модели. `TxOperations.diffUpdate` его мутирует (`applyUpdate(doc, ...)`
  после отправки tx) - на этом падала миграция `migrateViewlets` (`models/card/src/migration.ts`)
  с `Cannot assign to read only property 'config'`. Побочный эффект падения: в `model_tx` осталось
  22 `TxUpdateDoc` для Viewlet без соответствующего create, отсюда пачка warn
  `no document found, failed to apply model transaction, skipping` при старте воркспейса.
- **Переименование атрибута** (`TxUpdateDoc {name}`) оставляло его видимым и под старым именем:
  `addAttribute` кладёт запись по новому ключу, старую никто не убирал. С shared-моделью это
  особенно заметно - own-map класса это копия родительской, и фантом остаётся навсегда.
  `Hierarchy.txUpdateDoc` теперь чистит старый ключ и возвращает родительский атрибут, если тот
  занимал то же имя.

Покрытие: сценарный харнесс в `core/src/__tests__/sharedModel.test.ts` вырос до 25 операций
(атрибуты: добавление, скрытие, переименование своего и системного, смена типа и вложенного поля,
удаление, удаление с пересозданием, override и снятие override, атрибут на своём классе;
классификаторы: свой класс, свой миксин, миксин на системный класс, обновление существующего
миксина, переименование, смена `extends`, `implements`, смена домена, удаление класса, миксина,
интерфейса, удаление с пересозданием; документы: создание, обновление, удаление, удаление системного,
пересоздание, create+remove в одном батче; операторы `$push`/`$pull`/`$inc`/dotted `$set`).
Каждый сценарий сверяет полный снапшот - документы плюс `ancestors`/`descendants`/`own`/`all`
атрибуты/`domain`/`isDerived` каждого классификатора - у общей модели, у соседнего воркспейса,
прогретого до операции, и у свежего воркспейса, плюс проверяет что все документы остались frozen.
В `models/all/src/__tests__/sharedModel.test.ts` то же на реальной модели, включая `Status`,
`TaskType`, `ProjectType` (переименование, `$push`/`$pull` по `statuses`/`tasks`, удаление статуса),
`afterEach` сверяет и снапшот документов, и снапшот иерархии.

## Ревью 2026-09-01: kill-switch, `as()` на frozen, покрытие

- **`SHARED_SYSTEM_MODEL=false`** возвращает поведение до шаринга. Флаг живёт в
  `middleware/src/model.ts` (`sharedSystemModel`), точки переключения: `buildSharedModel` в
  `server-pipeline/src/pipeline.ts` (транзактор + backup), `pods/fulltext/src/manager.ts`,
  `services/rating/src/manager.ts`. Выключенный флаг не строит общий `ModelDb`, не морозит его и
  отдаёт `undefined` в `new Hierarchy(parent)` / `new ModelDb(h, parent)` - код тот же, оверлея нет.
  `services/rating` при этом всё равно строит `sysModel` (его читает `getIgnoreDomains`), просто не
  морозит и не шарит.
- **`Hierarchy.as()` копировал target на каждом вызове.** `{ ...target }` для frozen делался всегда,
  хотя proxy-инвариант нарушается только когда ключ миксина совпадает с корневым. На реальной модели
  это **3 случая из 887** (`server-notification:mixin:TypeMatch <- match`). Теперь копия делается
  только при реальном пересечении (`shadowsFrozenKey`), проверка идёт по `getAncestors(mixin)` -
  proxy падает и в ancestor-миксин, там коллизия такая же. Внутри `for...in`, а не `Object.keys`:
  путь горячий и не должен аллоцировать (с `Object.keys` heapΔ на 200k `as` был 68 Mb, стало 4 Mb).
- **Бенчи по всем методам чтения**, standalone против оверлея (`models/all/model.bench.test.ts`,
  `describeBench('model read performance')`): `isDerived`, `getAncestors`, `getDescendants` (Doc и
  все классы), `getClass`/`findClass`, `isMixin`, `getBaseClass`, `findDomain`, `getAllAttributes`,
  `getOwnAttributes`, `findAttribute`, `as`, `classHierarchyMixin`, `getMixinClasses`, `domains`,
  `findObject`, `findAllSync` (класс, `_id`, `$in`). Налог оверлея на p50 нулевой почти везде;
  заметно только `classHierarchyMixin` (0.33 -> 0.38 us) и `getMixinClasses` (167 -> 206 us, там
  `classifierIds()` строит Set на каждый вызов). `getDescendants(every class)` у оверлея вдвое
  быстрее - берёт готовые списки родителя.
- **Тесты эквивалентности** (`models/all/model.test.ts`, `describe('shared overlay answers like a
  standalone model')`): каждый read-метод сверяется по всем 501 классу, плюс чтение миксина с
  каждого frozen-документа модели. `core/__tests__/sharedModelEdge.test.ts` дополнен двумя случаями
  `as()`: без коллизии target остаётся общим инстансом (`toDoc(as) === doc`), коллизия через
  ancestor-миксин не роняет proxy.

### Открытое из ревью, не сделано
- `getAncestors`/`getDescendants` отдают mutable массив родителя. Проверено руками (267 сайтов), но
  инвариант ничем не держится - напрашивается `Object.freeze` на массивах общей иерархии.
- У `Hierarchy` нет `freeze()`: классификаторы, отфильтрованные из `ModelDb` (в fulltext/rating путь
  с `filter`, туда же попадают `core.class.Interface` - его нет в `fulltextModelFilter`), живут в
  общей иерархии незамороженными.
- `ModelDb.txUpdateDoc`/`txRemoveDoc` глушат исключения пустым `catch`, включая новое
  `frozen shared model must not be modified`.
- `Hierarchy.replaceDoc` не зовёт `invalidateChains()`; сейчас спасает только то, что все пути следом
  делают `hierarchy.tx` -> `ownClassifier`.
- `@hcengineering/measurements` прописан в `dependencies` у `models/all` и `middleware`, хотя bench
  нужен только тестам.
- **Порядок `hierarchy.tx` -> `model.tx` в парных сайтах** (`core/src/client.ts` `tx`/`updateFromRemote`,
  `server/indexer/src/indexer/indexer.ts` `processTransactions`) ломал rename атрибута из загруженной
  модели: иерархия пропускает update для `externallyOwned`, но `addAttribute(doc)` и чистка старого имени
  шли по ещё не обновлённому `doc.name` -> фантом под старым именем. Простая перестановка (`model.tx`,
  потом `hierarchy.tx`) даёт отставание иерархии на микротаск: два неожиданных `client.tx` (create класса,
  create документа этого класса) -> `ancestors not found`, tx не уходит на сервер. Итог: клиент зовёт
  `model.addTxes(ctx, [tx], true)` - синхронно, один инстанс на модель и иерархию, как `ModelMiddleware.tx`
  на сервере; `ClientImpl` получил `MeasureContext`. indexer оставлен парой в порядке model -> hierarchy.
  Тесты: `client.test.ts` (`client model transactions`: rename атрибута из `loadModel` и рантайм-созданного,
  unawaited-пара) и `sharedModelEdge.test.ts` (standalone + overlay).
- `txCreateDoc` клал в `externallyOwned` каждый model-документ (2799 на ws) - теперь только
  классификаторы/атрибуты, тест `tracks ownership only for classifiers and attributes`.
