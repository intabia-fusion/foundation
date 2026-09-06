# Dependency upgrade tooling

```bash
node common/scripts/outdated.js                                   # -> combined_dependencies/UPGRADE.md + upgrade_plan.tsv
node common/scripts/outdated-apply.js --category ui --bump patch  # бампает версии + печатает команду проверки
node common/scripts/outdated-bench.js fast-equals                 # сравнить текущую и целевую версию под нагрузкой
```

`outdated.js` сканирует все `@hcengineering/*` package.json, берёт latest из registry.npmjs.org (без `npm outdated`/`npm install`), тянет release notes с GitHub (нет релизов - diff CHANGELOG между тегами, иначе список коммитов), пишет `UPGRADE.md`: сводка по категориям, внутри - группы security / чистые patch-minor / patch-minor с breaking / major, ниже детали по пакету со ссылкой на `changes/<pkg>.md`.

Категории (ровно одна на пакет): `core ui svelte web dbs ai livekit otel collaboration-server integrations content desktop node build lint test` (+ `server`/`services` как fallback по путям).
- решают правила по имени пакета, порядок: node -> otel -> collaboration-server (`@hocuspocus/*`, yjs, y-*, lib0) -> livekit (livekit-*, @livekit/*) -> ai (openai, gigachat, js-tiktoken, @deepgram) -> dbs (mongodb, bson, postgres, minio, elastic, @aws-sdk/client-s3|lib-storage|s3-request-presigner, @smithy) -> core (uuid, morgan, fast-equals, fast-copy, hash-it, lru-cache, dotenv, commander, zod, msgpackr, winston...) -> lint -> desktop -> test -> svelte -> build -> web (express/koa стек, ws, cors, form-data) -> integrations (googleapis, octokit, telegram, stripe, nodemailer, passport, openid-client, @aws-sdk/client-ses) -> content (pdf/docx/markup/csv/archives: pdf-lib, pdfjs-dist, mammoth, sharp, markdown-it, dompurify, tar, puppeteer, node-forge, @signpdf/*);
- что не попало под правила - по путям потребителей (категория с наибольшим числом): `dev/tool`, `dev/import-tool` считаются server (рантайм-CLI), тесты - только `tests/ ws-tests/ qms-tests/ dev/storybook dev/test-base dev/benchmarks`, `common/` - build;
- `@types/x` наследует категорию `x`.

Ключевое:
- кэш `combined_dependencies/cache/` (npm-метаданные, GH releases/tags/compare) + `changes/*.md` с ключом по диапазону версий в первой строке. TTL `CACHE_TTL_DAYS` (7 дн.), сброс `--force`. Холодный прогон ~24с, повторный ~1.6с.
- прочие env/флаги: `SKIP_PACKAGES` (по умолчанию `@tiptap/`), `MAX_RELEASES`, `MAX_PAGES`, `--category`, `--no-notes`.
- semver: для 0.x minor трактуется как breaking; latest = максимальная стабильная версия (prerelease игнорируются).
- категория `node` ограничена мажором целевого Node (из `rush.json` nodeSupportedVersionRange, сейчас 24; override `NODE_TARGET_MAJOR`): `@types/node` предлагается 24.x, а не 26.x - типы нельзя гнать впереди рантайма.
- монорепо-теги вида `effector-react@23.3.0` отфильтровываются по basename, иначе в ноты попадают релизы соседних пакетов.
- `--category` выбирает набор зависимостей, но правит версии во всех package.json: rush check требует единую версию по репо. Замена текстовая, форматирование сохраняется. После применения пишется `combined_dependencies/verify.sh` (`rush update` + `rush fast-build:lint --to <затронутые>`).

## Статус на 2026-09-05 (пауза)

Обновлено и собрано (полный `rush fast-build:lint` зелёный, 461 пакет): категории `core`, `dbs`, `content`, `node` (@types/node 24.13.3, 307 файлов), `ws 8.21.3`, `postgres 3.4.9`, `msgpackr 2.1.0`, `openai 7.10.0`, `js-yaml 5.4.1`, `dompurify`, `on-headers`, `node-forge`, `gigachat`, `js-tiktoken`, `@aws-sdk/*`. Коммиты делает пользователь сам.
Не тронуто: `web` (27, express/koa/body-parser сознательно отложены), `build` (31, esbuild вынесен в foundation-tasks `docs/infra/2026-09-05-001-esbuild-upgrade-verification.md`), `test` (22), `integrations` (20), `content` хвост (19), `ui` (12), `lint` (12, prettier переформатирует всё), `desktop` (8, отдельным шагом), `collaboration-server` (6), `svelte` (5), `livekit` (2).
В рабочей копии на момент паузы: правки `dependency-pins.json` (снят msgpackr, добавлен tar-stream) + `pnpm-lock.yaml`.

## Пины (не обновлять выше)

`common/config/dependency-pins.json` - `maxMajor` или точная `maxVersion` + причина. outdated.js режет предлагаемый latest по пину и печатает причину в UPGRADE.md; apply не может уйти выше.
Текущие: fast-copy<=3 (v4 на 9-23% медленнее), svelte<=4 (runes), uuid<=11 (12+ ESM-only), intl-messageformat<=10 (11 ESM-only), lru-cache<=11.1.0 (в 11.5.2 get(hit) 0.86x, get(miss) 0.52x), dotenv<=16 (17 печатает 'injecting env' в stdout), tar-stream<=3.1.9 (3.2 кладёт собственные .d.ts поверх @types/tar-stream, они опираются на streamx без типов - `Pack` теряет `Readable`, ломается `server/backup`).
Пин msgpackr снят 2026-09-05: его обоснование не подтвердилось - 2.0 убирает только недокументированный `randomAccessStructure`/struct.js (у нас лишь `Packr`), проводной формат тот же, а повторный бенч 1.12.1 vs 2.1.0 дал паритет. Урок: пин ставить только с проверенной причиной, "на всякий случай" - нет.
msgpackr 2.1.0 нужен ради DoS-фикса, которого нет в 1.x (1.12.1 - последняя 1.x, бэкпорта не было): `unpack.js` в 1.x делал `new Array(length)` по заголовку до чтения данных, поэтому 5 байт `dd 01 31 2d 00` (array32 на 20M элементов, тела нет) отъедали 152.8 MB heap перед броском ошибки - усиление ~32e6 раз, любой клиент с бинарным каналом мог давить транзактор. В 2.1.0 добавлены проверки `length > srcEnd - position` (массив) и `/2` (map). Кросс-совместимость 1.x <-> 2.x проверена на нашей конфигурации `Packr({structuredClone, bundleStrings, copyBuffers:false})`: обе стороны читают друг друга, байты идентичны, включая Date/Map/Set/BigInt и циклы.

## Бенчи зависимостей

`common/scripts/outdated-bench.js <pkg> [verA verB] | --all` ставит обе версии рядом (alias `bench0`/`bench1` в `combined_dependencies/bench`, ESM грузится через loader.mjs) и меряет best-of-N интерливингом - фоновая нагрузка может только замедлить раунд, поэтому лучший раунд каждой версии сопоставим.
Сценарий: `common/scripts/bench/<pkg>.js`, экспорт `(module) => [{ name, run }]`, фикстуры в `bench/_data.js` (Doc-объекты, markup-дерево, 200 доков). Есть: fast-equals, fast-copy, uuid, lru-cache, msgpackr, ws, express, koa.
Серверные сценарии - async: экспортируют `{ cases, teardown }`, кейс помечается `{ async: true, concurrency: N }` (N операций в полёте). HTTP-сценарии (express/koa) держат клиента и сервер в одном процессе и упираются в undici (~24 ops/ms при concurrency 32 и 128 одинаково) - различия меньше ~10% там не значимы, для роутера нужен внешний нагрузчик. ROUNDS/ROUND_MS настраиваются.
Замеры 2026-09-05: fast-equals 6.0.3 быстрее 5.x на 7-31%; fast-copy 4.x медленнее 3.x на 9-23%; uuid 11 v4() в 4 раза быстрее 8.3.2 (parse() -22%, но parse в репо не используется); lru-cache 11.5.2 медленнее на чтении; msgpackr 2.1.0 pack -6%; ws 8.21.3 == 8.18.2; express 5.2.1 == 4.21.2 и koa 3.2.1 == 2.15.4 (в пределах шума стенда).

## Node

Минимальная версия Node - 24, `rush.json` `nodeSupportedVersionRange` = `>=24.0.0 <25.0.0` (было `>=20`). На других мажорах не тестируем. Категория `node` в отчёте автоматически ограничена этим мажором, поэтому `@types/node` предлагается 24.x.

## Грабли

- скан должен идти по всем package.json дерева, а не по `rush.json` projects и не по фильтру `@hcengineering/`: часть пакетов в скоупе `@intabiafusion/`, а `foundations/net` и `foundations/core` - вложенные rush-workspace, которых нет в корневом rush.json. Иначе часть файлов не бампается и `rush check` падает с mis-matching dependencies.
- сбор release notes нельзя обрывать на первой версии ниже текущей: ws публикует бэкпорты 7.x/6.x/5.x между релизами 8.x, из-за чего ноты обрывались на двух записях. Сейчас прерывание только после 10 подряд более старых релизов.
- postgres 3.4.8 сузил `TransactionSql`: он больше не присваивается к `Sql` (нет CLOSE/END/PostgresError/options). Ломается всё, что принимает `client: postgres.Sql`, а получает клиента из `begin()`/`retryTxn`. Починено алиасом `SqlClient = Sql | TransactionSql` в `server/account/src/collections/postgres/postgres.ts:82` и union-параметрами в `foundations/server/packages/postgres/src/utils.ts`, `services/worker/src/db.ts:94`.
- image-size 2.x: подпуть `image-size/fromFile` наш moduleResolution не резолвит (TS2307) - читать файл самим и звать `imageSize(buffer)`.
- `rush fast-build:lint --to a --to b` берёт ТОЛЬКО последний `--to`: параметр объявлен `string` в command-line.json, rush форвардит одно значение. Список передавать одним флагом через запятую: `--to a,b,c` (compile_all.js его разбирает). Иначе проверка молча сужается до одного пакета.
- `@types/node` держать одной версией по репо: две копии (22 и 24) ломают типы сторонних пакетов (`tar-stream`/`Pack`). В 24 удалён устаревший `Dirent.path` -> `parentPath`.
- обновление OTel до 0.222 сломало `new BatchLogRecordProcessor(exporter, opts)` - теперь экспортёр внутри options (`measurements-otlp/src/telemetry.ts`).
