---
name: release-changelog
description: Обновляет changelog.md новыми версиями из тегов origin и готовит русскую сводку по релизам с комментариями что сделано. Использовать когда просят "обнови changelog", "сводка по релизу", "release notes", "что вошло в версию vX.Y.Z".
---

# Release changelog + сводка

## 1. Найти новые версии

```
git fetch --tags origin
node common/scripts/update-changelog.js --allow-other-remote
```

Dry-run печатает версии после последней записанной в `changelog.md` и предлагаемые секции.
`--allow-other-remote` нужен, потому что remote зовётся `intabia-fusion/platform`.

Флаги: `--apply` (запись), `--from <X.Y.Z>` (другой якорь).

## 2. Собрать факты по каждой версии

Генератор скрипта валит почти всё в MISCELLANEOUS и теряет ссылки на issue -
использовать его только как список версий. Реальный список коммитов:

```
git log --no-merges --pretty=format:'%h|%ad|%s' --date=short <prev-tag>..<tag>
```

Для каждого коммита посмотреть что реально изменилось (без этого комментарии будут выдумкой):

```
git show --stat --format='' <sha>
git log -1 --pretty=format:'%s%n%b' <sha>
```

Читать список файлов: он говорит, какая подсистема затронута (`services/love`,
`server/account`, `plugins/workflow` и т.п.). Заголовок вида `FUSIO-1287 (#390)`
ничего не объясняет - расшифровку брать из файлов и тела коммита.

## 3. Записать секции в changelog.md

Формат существующих записей (сохранять его, не формат скрипта):

```
## [0.8.37] - 2026-09-03

* 🚀 FEATURES: · Заголовок ([#403](https://github.com/hcengineering/platform/issues/403))
* 🐛 BUG FIXES: · ...
* 🧩 OTHER: · ... · ...
```

Правила:
- Новые версии вставлять сверху, перед предыдущей секцией (файл в обратном порядке).
- Группы: 🚀 FEATURES / 🐛 BUG FIXES / 🧩 OTHER (catch-all, НЕ "MISCELLANEOUS TASKS").
- Каждый пункт - ссылка на issue по номеру PR из заголовка коммита.
- Дата секции = дата тега (`git for-each-ref --format='%(taggerdate:short)' refs/tags/vX.Y.Z`),
  она может отличаться от дат коммитов.
- Коммиты `Update release notes`, форматирование, bump зависимостей - не включать.

Вставка через python (не переписывать 500K файл целиком руками):

```
python3 - <<'PY'
p='changelog.md'; s=open(p).read()
anchor='## [<prev-version>] - <date>'
assert s.count(anchor)==1
s=s.replace(anchor, open('/tmp/new-sections.md').read()+anchor, 1)
open(p,'w').write(s)
PY
```

## 4. Русская сводка

Отдать markdown-списком, отдельный блок на версию, по пункту на изменение:

```markdown
## 0.8.37 - 2026-09-03

- **FUSIO-1316 Проверки доступа (#403)** - исправлены `spaceSecurity` middleware и
  `sessionManager` (дыра в проверке прав на пространства); добавлены unit- и bench-тесты.
```

- Жирным - тикет/заголовок + номер PR, после тире - что конкретно сделано.
- Комментарий пишется по диффу, а не по заголовку. Не знаешь что делает коммит - открой файлы.
- Ключевые файлы/модули упоминать в backticks.
- НИКОГДА не вкладывать `code` внутрь **bold**: ProseMirror-редакторы (smartPaste)
  падают на такой вставке - `RangeError: Invalid collection of marks for node text: bold,code`.
  Заголовок пункта - только жирный текст, backticks выносить в описание после тире.

## Границы

- Коммиты и теги не делать без явной просьбы.
- Версию в `common/scripts/version.txt` не трогать: это модель, а не релиз.
