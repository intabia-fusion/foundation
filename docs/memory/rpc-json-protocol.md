# RPC: протокол транзактора

Дефолт клиентского протокола - **msgpack + snappy**. JSON включался дефолтом 2026-09-01 и откачен
после замеров на реальных данных (см. ниже). Env-переключатель оставлен: `USE_BINARY_PROTOCOL=false`
переводит на JSON.

## Почему JSON пробовали и почему откатили

Довод был: snappy снял главное преимущество msgpack, на сжатых данных остаётся около 3% трафика.
Замер делали на `models/all/bundle/model.json` - и только на нём. На корпусе из БД стенда (67
классов, 11460 документов) json стоит **+27.7%** трафика в сумме и до +75% на отдельных классах.
Модель оказалась нетипично хорошо сжимаемой; подробности ниже. Откачено, дефолт снова msgpack.

## undefined нельзя коэрсить в null

`rpcJSONReplacer` в `foundations/core/packages/rpc/src/rpc.ts` заканчивался
`return value ?? null`. На JSON это превращало `retrieve: undefined` в `retrieve: null`, а
`NormalizeTxMiddleware.parseTxCUD` принимает только `undefined` или `boolean` - каждый
`TxUpdateDoc` отлетал с `BadRequest`, логин висел до таймаута. На msgpack не проявлялось:
msgpackr со `structuredClone: true` сохраняет `undefined`.

`?? null` стоял ровно затем, чтобы ключ со значением `undefined` не терялся при
`JSON.stringify`. С 2026-09-05 строка возвращена к develop-варианту `return value ?? null`, но
она больше ни на что не влияет: replacer убран из `JSON.stringify` и вызывается только из
`serialize()` на top-level `result`, который под `if (result !== undefined)`. Проверено:

```
msgpack | retrieve key: true  | ops keys: ['a']
json    | retrieve key: false | ops keys: []
```

То есть валидатор больше не увидит `retrieve: null`, а ключи с `undefined` json всё равно
теряет - это свойство `JSON.stringify`, а не этой строки. `TxProcessor.applyUpdate` идёт
`for (const key in ops)` (`tx.ts:389`), т.е. наличие ключа значимо: `{ field: undefined }` на
msgpack очищает поле, на json - no-op. Пока дефолт msgpack, зафиксировано тестами и не горит.

Мораль: json-ветка протокола не была покрыта ничем, пока дефолтом был msgpack. В `clisr`
та же ситуация - `binary` захардкожен `true`, json-путь там не проверен.

## Переключатели

- Веб: `USE_BINARY_PROTOCOL=true` на front-поде (идёт в `/config.json` через
  `pods/front/src/__start.ts`), либо ключ `client:metadata:UseBinaryProtocol` в `localStorage`.
- Серверные клиенты (`server-client`, `pod-github`): переменная `USE_BINARY_PROTOCOL`.
- `binary` и `compression` меняют только парой: JSON без сжатия - худший из четырёх режимов
  (2.09 МБ против 1.37 МБ на модели), поэтому дефолт `compression` в `connection.ts` тоже
  поднят в `true`.

Для A/B через Playwright `storageState` не годится: тесты, создающие контекст через
`browser.newContext({ storageState: PlatformSetting })`, ключ из конфига не видят - в первом
контрольном прогоне на msgpack ушли 108 сессий из 906. Переключать надо env фронта.

## Где протоколы реально расходятся (перебор)

`foundations/core/packages/rpc/src/test/protocol.spec.ts` перебирает значения, все операторы
`DocumentUpdate` и предикаты запроса, гоняет каждый вариант через обе ветки `RPCHandler` и
сравнивает канонические подписи. Списки расхождений зафиксированы в `toEqual` - новая строка
означает, что поведение изменилось. Запуск: `npx jest src/test/protocol.spec.ts` из пакета.

Расхождения по значениям: `undefined` (верхний уровень - json падает на `JSON.parse`),
`NaN`/`±Infinity` -> `null`, `bigint` -> `TypeError`, одиночный суррогат, `Date` -> ISO-строка,
`RegExp`/`Map`/`Set`/`Uint8Array`/`ArrayBuffer` -> `{}` или объект-индекс, `undefined` в массиве и
дырка в разреженном массиве -> `null`, поле со значением `undefined` - **ключ исчезает**,
`toJSON` вызывается только в json, цикл - `TypeError`, общая ссылка дублируется.

Обратное тоже есть: msgpackr теряет `-0`, `total`/`lookupMap` у массива (их спасает только
replacer в `serialize`), переименовывает `__proto__` в `__proto_`, роняет `Symbol`.

Практический эффект на `TxProcessor.applyUpdate` (он идёт `for (const key in ops)`, т.е. значимо
само наличие ключа):

- `{ field: undefined }` - msgpack **очищает** поле, json оставляет старое значение
- `$unset: { field: undefined }` - msgpack снимает поле, json не делает ничего
- `$push`/`$update` с `undefined` - у msgpack элемент добавляется/затирается, у json нет
- `$push: { $each: [undefined] }` и `$pull: { $in: [undefined] }` - json подставляет `null`
- `Date` в любом операторе доезжает строкой, поэтому `$pull` по `Date` в json не находит элемент

## Бенч: model.json был нерепрезентативен

`foundations/core/packages/client-resources/src/__tests__/protocol-bench.spec.ts` - синтетика,
байты + ops/sec + p50/p90/p99, snappy в замере, ~8s, идёт в `rushx test`. Синтетика однородная и
потому льстит msgpackr (record extension сворачивает повторяющуюся форму документа).

Настоящий замер - на данных из БД стенда. Выгрузка (67 классов, 11460 документов):

```sql
-- docker exec sanity-postgres-1 psql -U postgres -p 5433 -d postgres -Atc "..."
with all_docs as (
  select _class, (to_jsonb(t) - 'workspaceId' - '%hash%' - 'data') || coalesce(data,'{}'::jsonb) as doc from tx t
  union all select ... from documents t   -- и так по каждому домену
), ranked as (
  select _class, doc, row_number() over (partition by _class order by random()) rn from all_docs
)
select jsonb_object_agg(_class, docs)::text from (
  select _class, jsonb_agg(doc) docs from ranked where rn <= 500 group by _class) x;
```

Каждый payload - `Response` с `result` = страница документов. Медиана по бакетам (snappyjs,
проценты = дельта ops/s, отрицательное = json медленнее):

| размер на проводе | payloads | msgpack B | json B | json трафик | json encode | json decode | json без reviver |
|---|---:|---:|---:|---:|---:|---:|---:|
| < 1 КБ | 68 | 419 | 419 | +0.3% | +8.2% | -63.5% | **+32.0%** |
| 1-10 КБ | 40 | 3 863 | 4 577 | +16.9% | -27.8% | -88.2% | -50.4% |
| 10-100 КБ | 14 | 29 775 | 37 569 | +33.0% | -37.1% | -90.2% | -62.4% |
| > 100 КБ | 2 | 623 039 | 861 097 | +38.2% | +12.5% | -79.2% | -27.7% |

Сумма по всем страничным payload'ам: msgpack 1 587 524 B против json 2 027 010 B, **+27.7%**.

| payload | msgpack B | json B | json трафик | msgpack dec | json dec | json без reviver | native msgpack dec |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed page-50 | 9 945 | 10 060 | +1.2% | 0.069 ms | 0.286 | 0.074 | 0.059 |
| mixed page-500 | 68 593 | 88 294 | +28.7% | 0.677 | 3.132 | 0.894 | 0.494 |
| mixed page-5000 | 623 039 | 861 097 | +38.2% | 6.425 | 30.935 | 9.198 | 4.837 |
| **model.json full** | 301 715 | 310 555 | **+2.9%** | 3.969 | 19.004 | 5.327 | 2.838 |

**Вывод: «около 3% трафика» верно только для `model.json` и больше ни для чего.** Модель - 3885
разнородных tx с длинными уникальными строками, snappy на них съедает разницу почти полностью. На
обычных страницах документов json стоит +17..38%, в сумме по корпусу +27.7%. Исходное решение
опиралось на единственный нетипичный payload.

Хуже всего json на маленьких однотипных документах с повторяющимися ключами: `love:class:Room`
page-500 +75.5%, `love:class:Office` +64.6%, `documents:class:DocumentCategory` +43.2%. Лучше
всего - на текстовых: `tags:class:TagCategory` +5.1%, `chunter:class:ChatMessage` +10.6%.

## Reviver стоит дороже самого протокола

`rpcJSONReceiver` передаётся в `JSON.parse` третьим аргументом и вызывается на каждый ключ. Он нужен
ради одного `dataType: 'TotalArray'`.

- payload < 1 КБ: голый `JSON.parse` **быстрее** msgpackr на 32%, а с reviver - медленнее на 63.5%
- mixed page-5000: 30.9 ms -> 9.2 ms
- model.json: 19.0 ms -> 5.3 ms

То есть reviver разворачивает знак сравнения на мелочи и даёт 3.4x на крупном. Убрать его
(разбирать TotalArray пост-обходом только там, где он вообще возможен) - самая дешёвая правка из
всех, и она не требует откатывать протокол.

## Две реализации snappy

`pods/server` и `pods/stats` уже зависят от нативного `snappy@7` (napi), браузер вынужден жить с
`snappyjs` (чистый JS). Кто что делает: клиент отправляет **без сжатия** (`connection.ts` только
`serialize`), сервер сжимает ответы нативным `compress` (`server_http.ts:62`, `rpc.ts:57`), браузер
разжимает через `snappyjs`. Сервер входящее не разжимает вообще.

Нативный против snappyjs на тех же данных: на мелочи (<400 B) нативный compress +50-60%, а
uncompress на 7-17% **медленнее** - накладные napi съедают выигрыш. От ~9 КБ и выше нативный
быстрее в 1.7-3.5x в обе стороны (model-full: decompress 2.70 vs 4.08 ms). Выход байт совпадает с
точностью до 1-4 байт, форматы взаимозаменяемы.

Практический вывод: серверная сторона уже на нативном. Node-клиенты платформы (love, aibot,
workspace, github) ходят через `client-resources`, а он импортирует `snappyjs` - там decode модели
идёт по медленному пути. Это отдельная возможная оптимизация, но пакет браузерный, так что нужен
условный импорт.

## msgpackr остаётся на 1.x (решение 2026-09-05)

Проверяли бамп 1.11.5 -> 2.1.0. Выход **побайтово идентичен** на всех payload'ах, скорость в
пределах шума или чуть хуже. Харнес репозитория (`common/scripts/outdated-bench.js msgpackr
1.11.5 2.1.0` в foundation4, best of 9, ops/ms):

| case | 1.11.5 | 2.1.0 |
|---|---:|---:|
| pack single doc | 1783.7 | 1662.5 (0.93x) |
| unpack single doc | 1126.8 | 1132.7 (1.01x) |
| pack 200 docs | 9.2 | 8.9 (0.97x) |
| unpack 200 docs | 6.3 | 6.3 (1.00x) |
| pack markup tree | 77.2 | 83.9 (1.09x) |

Выгоды нет, а цена - синхронная выкатка клиента и сервера (сетевой формат). В develop это уже
зафиксировано пином `msgpackr<=1` в `common/config/dependency-pins.json`. Решено оставить 1.x.


## Reviver оставлен: развёрнутые клиенты

`rpcJSONReplacer`/`rpcJSONReceiver` идут третьим аргументом в `JSON.stringify`/`JSON.parse`, то
есть вызываются на каждый ключ. Пробовали убрать - decode ускоряется в 4-5x (`docs-2000`
12.08 -> 2.50 мс, `mixed-2000` 8.27 -> 1.94), encode в 2.8x. **Откачено: уже собранные клиенты
продолжают ходить с этой парой**, они шлют обёртку `{ dataType: 'TotalArray' }` и ждут её обратно.
Снимать можно только синхронно с клиентами.

Побочный эффект от того, что replacer остался: `undefined` превращается в `null`, поэтому ключ
**доезжает**, а не теряется. Это то, что нужно - см. следующий раздел.

Что оставили из правок: guard `Array.isArray(value.value)` в `rpcJSONReceiver`. Без него документ
с полем `dataType: 'TotalArray'` и не-массивом в `value` разворачивался через `Object.assign` в
boxed-строку (`{0:'n',1:'o',...}`).

## null принимается валидатором

`NormalizeTxMiddleware` (`foundations/server/packages/middleware/src/normalizeTx.ts`) требовал
строго `undefined` в опциональных полях, и `retrieve: null` от json-клиента давал `BadRequest`.
Теперь принимает `null` и сразу нормализует его в `undefined`: `createdBy`, `createdOn`, `meta`,
`scope`, `match`, `notMatch`, `notify`, `extraNotify`, `measureName`, `attachedTo`,
`attachedToClass`, `collection`, `retrieve`, `removedDoc`. Обязательные поля (`_class`, `_id`,
`space`, `modifiedBy`, `modifiedOn`, `objectSpace`, `objectId`, `objectClass`, `operations`,
`attributes`, `mixin`, `txes`, `event`, `domain`) `null` по-прежнему не принимают.

Вместе с replacerом это закрывает потерю ключа: `{ field: undefined }` доезжает как
`{ field: null }`, `$unset: { keep: undefined }` работает так же, как на msgpack. Остаточные
расхождения - только по типу значения (`undefined` -> `null`, `NaN` -> `null`, `Date` -> строка),
и они зафиксированы в `protocol.spec.ts`.

## Замеры на стенде не сходятся с бенчем

Контроль (msgpack) шёл с `compression` дефолтом `false`, json-прогоны - с `true`
(`connection.ts`), сервер сжатие разрешает (`ENABLE_COMPRESSION=true` в `tests/docker-compose.yaml`,
`sessionManager.ts:1811`). То есть сравнивались msgpack-без-сжатия против json+snappy, и по бенчу
трафик должен был **упасть** в разы. Фактически `client.ws.received_bytes` изменился на +1%/+6.5%,
`sent_bytes` на +5%. Ни одна из трёх конфигураций такого не даёт - прежде чем верить сравнению
прогонов, надо залогировать фактически согласованные `binary`/`compression` из `HelloResponse`.
