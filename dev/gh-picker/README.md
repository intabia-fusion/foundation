# gh-picker

TUI для cherry-pick коммитов в обе стороны: из `upstream/develop` в твою ветку (incoming) и из твоей ветки в новую ветку на `upstream/develop` для PR (outgoing).

## Установка

```bash
cd dev/gh-picker
go build -o gh-picker .
```

Или в PATH:
```bash
ln -s $(pwd)/dev/gh-picker/gh-picker /usr/local/bin/gh-picker
```

## Запуск

```bash
./dev/gh-picker/gh-picker
# или
./dev/gh-picker/gh-picker -branch upstream/main
```

## CLI режим (без TUI)

```bash
gh-picker report [flags]      # что осталось перенести по группе пакетов
gh-picker packages [flags]    # сводка расхождений по всем пакетам
gh-picker skip <hash>...      # решили не переносить -> убрать из report
gh-picker unskip <hash>...
gh-picker applied <hash>...   # отметить применённым в ~/.gh-picker/<repo>.json
```

Без `-check` состояние берётся из patch-id (`git log --cherry-pick`), applied cache и
ignore store. Ни один из трёх не видит порт, который у нас лёг squash-ем или был
переработан - для этого нужен `-check`.

`report` флаги:

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `-branch` | `upstream/develop` | remote ref для сравнения |
| `-local` | `HEAD` | локальный ref |
| `-group` | `card,process` | `card`, `process`, `all` или список |
| `-paths` | - | явные pathspec через запятую, перебивает `-group` |
| `-author` | - | подстрока автора (`-author bykhov`) |
| `-state` | `todo` | `todo`, `applied`, `skipped`, `any` |
| `-files` | false | показать затронутые файлы |
| `-check` | false | пофайловая проверка контента против HEAD (медленно, ловит squash/переработанные порты) |
| `-no-cherry` | false | не отбрасывать коммиты, чей patch-id уже есть локально |
| `-json` | false | JSON |

Порядок вывода - от старых к новым, то есть порядок cherry-pick. Отбор уже
применённого - `git log --cherry-pick` (по patch-id) плюс applied cache и
ignore store, общие с TUI.

```bash
# что от Дениса надо перенести по карточкам/процессам
./dev/gh-picker/gh-picker report -author bykhov
# только процессы, с файлами
./dev/gh-picker/gh-picker report -group process -files
# где ещё расходимся и насколько
./dev/gh-picker/gh-picker packages -min 5
```

`packages`: `INCOMING` - коммитов надо забрать из upstream, `OUTGOING` - наших,
которых нет в upstream. Пакет = первые два сегмента пути (`plugins/card`).

## Пакетный cherry-pick

`dev/pick-upstream.sh <файл-с-хэшами> [лог]` - последовательный cherry-pick с
`-x -X ours`: любой конфликт разрешается в нашу пользу, пустые после этого коммиты
скипаются, каждый севший коммит отмечается в applied cache. Батч не останавливается:
то что git не смог применить вообще - `--abort` и `FAILED` в логе.

Список хэшей берётся из `gh-picker report -json`. `-x` кладёт upstream-хэш в
сообщение - следующий прогон опознает порт по трейлеру.

Важно: `-X ours` разрешает конфликтующие хунки молча, cherry-pick при этом
"успешен". После батча обязательно:

1. сравнить каждый севший коммит с оригиналом (numstat по файлам) - ловит
   потерянные строки;
2. `cd <pkg> && rushx svelte-check` в каждом затронутом svelte-пакете - ловит
   подменённые (шаблон ссылается на переменную, которой в скрипте нет). Ни
   eslint, ни tsc это не видят. `rush svelte-check` вывод глотает, гонять
   только в самом пакете.

См. `docs/memory/upstream-sync.md`.

## Чистка тегов upstream

`dev/clean-upstream-tags.sh` удаляет локальные теги, которые пришли из
`upstream` и отсутствуют в `origin`/`haiodo`. Dry run по умолчанию.

```bash
./dev/clean-upstream-tags.sh          # показать
./dev/clean-upstream-tags.sh --apply  # удалить + remote.upstream.tagOpt=--no-tags
FROM=upstream KEEP=origin,haiodo ./dev/clean-upstream-tags.sh
```

Удаляются только локальные теги, remote не трогается.

## Режимы

| Режим | Описание |
|-------|----------|
| **Incoming** (по умолчанию) | Коммиты из `upstream/develop`, которых нет у тебя. `c` cherry-pick в текущую ветку |
| **Outgoing** | Коммиты из твоей ветки, которых нет в `upstream/develop`. Фильтр по дереву папок. `m` мигрирует в новую ветку |

`o` переключает режим.

## Outgoing режим

Три панели:
1. **Folders** - дерево файлов затронутых outgoing коммитами. Выбор папки фильтрует commits по ней (Space/Enter на папке)
2. **Commits** - коммиты, отфильтрованные текущей папкой
3. **Diff** - diff текущего коммита

Выбираешь нужные коммиты (Space), жмешь `m`, вводишь имя новой ветки. Инструмент:
1. Создает ветку от `upstream/develop`
2. Для каждого коммита применяет **только файлы под выбранной папкой** (если папка не выбрана - весь коммит), автор/сообщение сохраняются
3. Коммиты без файлов под папкой пропускаются
4. Возвращается на исходную ветку
5. Помечает эти коммиты как `migrated` (скрываются из списка)
6. Показывает команду для push

Diff в центральной панели показывает **только файлы под выбранной папкой** - то что реально попадет в новую ветку.

Push делаешь сам: `git push -u upstream <branch>`, потом открываешь PR.

## Управление

| Клавиша | Действие |
|---------|----------|
| `↑/k` `↓/j` | Навигация |
| `←/h` `→/l` | Фокус на дерево / коммиты (outgoing) |
| `PgUp/PgDn` | Прокрутка |
| `Tab` | Циклически переключить фокус |
| `Space/Enter` | Toggle commit / выбрать папку в дереве |
| `a` | Выбрать все / снять все |
| `c` | Cherry-pick выбранных (incoming) |
| `m` | Migrate выбранных в новую ветку (outgoing) |
| `o` | Переключить incoming/outgoing |
| `r` | Обновить |
| `x` | Игнорировать коммит (в ignored view - вернуть) |
| `i` | Переключить list/ignored view |
| `?` | Помощь |
| `q/esc` | Выход |

## Ignore / migrated

Сохраняются в `.git/gh-picker-ignored` (локально, не коммитится). Формат:
```
incoming <hash>
outgoing <hash>
migrated <hash>
```

В outgoing ignored view показываются и ignored, и migrated (последние с маркером `[M]`).

## Applied cache (~/.gh-picker)

Incoming коммиты, которые уже точно применены (весь контент есть в HEAD -> `CherryPicked=true`, не Partial) или помечены вручную клавишей `A`, кэшируются в `~/.gh-picker/<repo-slug>.json` (per-repo, вне git-dir - переживает worktree/clone). При загрузке такие коммиты пропускают дорогую пофайловую проверку.

Инвалидация hash-based: hash коммита не меняется -> контент не меняется, раз применён - скипается навсегда. `r` (refresh) НЕ перепроверяет закэшированные. Сброс - клавиша `R` (очистить кэш repo + перезагрузка).

`A` - пометить applied (кэш + скрыть), `x` - ignore (скрыть без кэша). Разные понятия.

## Восстановление позиции курсора

После refresh, cherry-pick или migrate курсор возвращается на hash, на котором стоял. Если его уже нет в списке - на позицию 0.

## Файлы

- `main.go` - CLI, диспетч подкоманд
- `report.go` - `report` / `packages` / `skip` / `unskip`
- `ui.go` - Model, KeyMap, styles, Init
- `update.go` - Update loop, обработчики клавиш, prompt
- `render.go` - View и все render* функции
- `filter.go` - фильтры по ignored/folder
- `tree.go` - treeNode + rebuild
- `commands.go` - tea.Cmd + messages (load/cherry-pick/migrate)
- `git.go` - обертки над git
- `ignore.go` - IgnoreStore (`.git/gh-picker-ignored`)
