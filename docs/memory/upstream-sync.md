# Синк с upstream (Platform-Collective/platform)

## Контекст

- `upstream` = `https://github.com/Platform-Collective/platform`, база с которой начинали.
- Точка расхождения: `f94d564ec6` "Support default invite setting in branding (#10591)", 2026-03-05.
- На 2026-07-30: 341 коммит в upstream не у нас, 965 наших не в upstream.
- Приоритет переноса: `card` и `process` пакеты. Остальное - решать по месту.

## Теги

`git fetch upstream` притащил 69 тегов (`s0.7.351..s0.7.423`, `v0.7.411/413/423`),
которых нет ни в `origin`, ни в `haiodo`. Совпадающих по имени, но расходящихся по
SHA тегов нет - т.е. критерий "имя есть только в upstream" достаточен.

Чистка: `dev/clean-upstream-tags.sh --apply`. Он же ставит
`remote.upstream.tagOpt=--no-tags`, чтобы повторный fetch не тянул теги.

## Инструменты

`dev/gh-picker` - TUI плюс CLI подкоманды `report` / `packages` / `skip` / `unskip`.

Отбор "уже применённого" - три независимых механизма:
1. `git log --cherry-pick` по patch-id (встроенный, ловит честные cherry-pick).
2. applied cache `~/.gh-picker/<repo-slug>.json` (hash-based, из TUI клавиша `A`).
3. ignore store `.git/gh-picker-ignored` (`skip` = решили не переносить).

Pathspec в `report` идут с префиксом `:(top)` - иначе они резолвятся относительно
cwd, и запуск из `dev/gh-picker/` даёт пустой результат.

`git log --format` не может содержать NUL в argv (`fork/exec: invalid argument`),
поэтому разделители записей - `\x1e`/`\x1f`.

## Ловушки идентификации

Три вещи давали ложные результаты, все три починены:

1. **cwd.** `gh-picker` резолвил pathspec относительно cwd. Запуск из `dev/gh-picker/`
   давал пустой `git diff` -> `fileSkip` по всем файлам -> `total == 0` ->
   "уже применён" для 100% коммитов. Фикс: `chdirToRepoRoot()` в `main.go` плюс
   `:(top)` на pathspec в `report.go`.
2. **index.lock.** Параллельный content-check ронял read-only `git diff`/`git apply`
   на гонке за index.lock, ошибка молча трактовалась как "нет изменений". Фикс:
   `GIT_OPTIONAL_LOCKS=0` в `GitExecIn` и `runApplyCheck`. До фикса результат
   плавал между прогонами (26/9/32 vs 21/10/36).
3. **Нет следов порта.** В нашей истории 0 трейлеров `cherry picked from commit`
   и 0 совпадений по subject - предыдущие порты были squash/переработаны. Только
   `-check` (пофайловое сравнение контента) даёт реальную картину.

Теперь `pick-upstream.sh` пикает с `-x`, так что следы появляются.

## Перенос коммитов Дениса (2026-07-30)

Ветка `platform-sync` от `783a28ca1c`. Из 67 коммитов Дениса по card/process
`-check` показал 21 уже применённых, 10 частично, 36 нетронутых. Пикнуто 46
(`dev/pick-upstream.sh`, `-X ours`): 35 чисто, 8 с разрешением конфликтов в нашу
пользу, 3 оказались пустыми. 43 коммита село, 0 провалов.

Конфликты на уровне файлов были только в `ko.json`/`pl.json` локалях и
`templates/package/package.json`.

### Что сломал `-X ours` (нашлось сравнением numstat с оригиналом)

`-X ours` разрешает конфликтующие хунки молча и cherry-pick при этом "успешен".
19 из 43 коммитов легли не так, как в upstream. Реальные поломки:

- `models/server-card`: потерян `import view from '@hcengineering/view'` при
  используемом `view.class.Viewlet` + отсутствовал dep в package.json
- `plugins/process-resources`, `server-plugins/process-resources`: не добавился
  dep `@hcengineering/text-core`, хотя код его импортирует
- `plugins/converter-resources/src/formatter/valueFormatter.ts`: потеряны
  `type Ref` и импорты `formatDateValue`/`isIntlString` из `./utils`
- `plugins/card-resources/src/utils.ts`: два импорта из `@hcengineering/rank`
- `models/card/src/index.ts`: два импорта `@hcengineering/notification`
- `plugins/card/src/index.ts`: не добавился `ShowAllVersions: '' as IntlString`,
  хотя модель на него ссылается
- `foundations/core/.../classes.ts`: не добавилось `required?: boolean` в
  `Attribute` (компилировалось за счёт index signature `[key: string]: any`)
- версии deps из upstream (`text@0.7.19`, `text-markdown@0.7.21`,
  `update-browserslist-db@1.2.3`) не совпадают с нашими - откатывал к нашим

Половинчатые хунки в viewlet (важно, тут легко пропустить):
`ViewletSetting.svelte` и `card-resources/.../ViewSetting.svelte` получили
`const proxiedValue = ...`, но условие дедупликации `key === proxiedValue`
из #10674 не применилось - переменная оставалась мёртвой, дубли mixin-атрибутов
в настройках вьюлета возвращались. Дописано вручную.

Наша сторона в viewlet сохранена: секция CUSTOM ATTRIBUTES, `isCustom` skip,
`deduplicate` в `DocTable`, `canEditSpace`. Из upstream НЕ взято:
`addAssociationAttributes` (вложенные атрибуты ассоциаций, #10808) и
`$associations`-ветка в `valueFormatter` - конфликтовали с нашим кодом.

### Проверка

`rush fast-build:lint --to <pkg>` по всем 34 затронутым пакетам - чисто.
`rush fast-build:lint` принимает только один `--to` при большом числе
аргументов - гонять в цикле.

**`rush svelte-check` глотает вывод.** Показывает `FAILURE: <pkg>` с пустым
телом, и легко принять за предсуществующий шум - я так и сделал, и пропустил
три реальные регрессии. Гонять надо в самом пакете: `cd <pkg> && rushx
svelte-check`, тогда печатаются `File:`/`Message:`. Красный в `hls`/
`tags-resources` был каскадом из `presentation`/`view-resources` - они тянут
исходники соседей по относительному пути.

Ни eslint, ни tsc НЕ ловят обращение к необъявленной переменной внутри
svelte-шаблона: компилятор трактует её как глобал, значение `undefined`.
Единственный детектор - svelte-check.

### Регрессии, найденные по упавшим e2e (2026-07-31)

Playwright дал 19 падений (inbox, chat, contacts, indexer, org.members) - все
вне card/process, что и сбивало с толку. Корень - три полу-применённых хунка:

1. `packages/presentation/.../AttributeBarEditor.svelte` - **главная**.
   Пик заменил `value={getAttribute(client, object, ...)}` на `{value}`
   (шорткат upstream), но реактив `$: value = ...` не лёг, потому что наш
   скрипт свой (`resolved` + `reduceCalls`). `value` стал `undefined` для
   **каждого** редактора атрибутов в приложении. Симптом в тестах:
   `locator('div.popupPanel-body div.textInput div.tiptap')` - element not
   found. Заодно не было `isRequiredAndEmpty`. Дописано под нашу структуру.
2. `plugins/view-resources/.../ViewletSetting.svelte:667` - `getConfig` стал
   `async`, но вызов остался `{@const citems = getConfig(...)}` -> в
   `ViewletClassSettings` уезжал Promise вместо массива. Обёрнуто в `{#await}`.
3. `plugins/card-resources/.../MarkupProperties.svelte` - `toRank`
   импортировался из `@hcengineering/core`, которого там нет (он в
   `@hcengineering/rank`) -> `undefined` при сортировке атрибутов.

Вывод: numstat-сравнение с оригиналом ловит потерянные строки, но не ловит
подменённые. После `-X ours` обязателен `rushx svelte-check` в каждом
затронутом svelte-пакете.

### Тесты

E2E по card/process нет ни у нас, ни в upstream - в `tests/sanity/tests` таких
спеков не существует. Есть только jest-юниты в самих пакетах, 6 файлов, все
проходят после переноса (41 тест).

Денис не трогал тесты ни в одном из 67 коммитов, перенесённые 43 коммита не
задели `tests/` вообще.

У upstream есть два card-теста, которых у нас нет:
`cardTableFormatter.test.ts` и `markupCellRoundTrip.test.ts` - оба из
`8d95d32cfe` (Savchenko, #10840), это один из непереносившихся коммитов.

Конфликты по `ko.json`/`pl.json` оказались безобидными: этих локалей у нас нет
вообще (добавлены в upstream в #10820/#10907), так что "ours" = файл отсутствует.
`makeLocalesTest` сверяет только `en` против `ru`. Ключи по всем локалям выросли
синхронно (card +4, process +13), предсуществующие пробелы (cs/de/tr -5,
pt-br -12, ja -1) не изменились.

## Осталось (2026-07-30)

10 коммитов по card/process от других авторов (Artyom Savchenko x7, локали
pl/ko, Safari user-select) - не переносились, вне запроса.

Топ расхождений вне card/process: `foundations/core` 37, `plugins/view-resources` 31,
`plugins/love-resources` 27, `common/config` 26.
