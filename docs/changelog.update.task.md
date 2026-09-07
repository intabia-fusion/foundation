<!--
Copyright © 2026 Intabia Fusion.

Licensed under the Eclipse Public License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may
obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

See the License for the specific language governing permissions and
limitations under the License.
-->

# Инструкция: обновление `changelog.md`

Этот документ описывает порядок действий для обновления `changelog.md` с помощью скрипта
`common/scripts/update-changelog.js`.

Кратко: скрипт смотрит теги на `origin`, получает коммиты для каждой новой версии (после последней версии,
указанной в `changelog.md`), отфильтровывает мерджи и `Signed-off-by:`-футеры, оставляет только
«существенные» коммиты (см. раздел про критерии) и генерирует секции для файла `changelog.md`.

---

## Где находится скрипт
`common/scripts/update-changelog.js`

По умолчанию скрипт:
- проверяет теги на `origin` (только remote `origin`, см. замечание ниже),
- выполняет `git fetch --tags origin` (чтобы локально были нужные теги),
- запускается в режиме dry-run (не записывает файл) — для записи нужно использовать `--apply`.

> Важно: по задаче теги нужно смотреть в `origin` только. Скрипт поддерживает флаг `--origin`, однако
> стандартный рабочий процесс использует `origin`.

---

## Быстрый сценарий (шаги)

1. Обновить локальные теги (опционально; скрипт попытается сделать это сам):
   ```
   git fetch --tags origin
   ```

2. Просмотреть предлагаемые изменения (dry-run):
   ```
   node common/scripts/update-changelog.js
   ```
   Скрипт выведет, какие версии найдены на `origin`, и «предлагаемые» секции для вставки в `changelog.md`.

3. Внимательно просмотреть предложенные секции и списки коммитов (в консоли или открыть `changelog.md` вручную).

4. Если всё ок — применить изменения в `changelog.md`:
   ```
   node common/scripts/update-changelog.js --apply
   ```

5. Проверить результат:
   ```
   git --no-pager diff changelog.md
   # или открыть файл в редакторе
   ```

6. Закоммитить и отправить изменения в отдельной ветке (создать PR для ревью):
   ```
   git checkout -b chore/update-changelog/<range>
   git add changelog.md
   git commit -m "chore(changelog): update changelog for <versions>"
   git push origin HEAD
   ```

7. Запросить ревью, поправить, при необходимости — принять PR и слить.

---

## Полезные параметры скрипта

- `--apply` — непосредственно записать изменения в `changelog.md` (по умолчанию — dry-run).
- `--origin <name>` — указать другой remote (по умолчанию — `origin`). По политике обычно используем `origin`.
- `--from <X.Y.Z>` — принудительно переопределить «последнюю версию» в `changelog.md` (если нужно использовать другой якорь).

Пример:
```
node common/scripts/update-changelog.js --origin origin --apply
```

---

## Что именно фильтруется и как формируется список изменений

- Мердж-коммиты исключаются (скрипт фильтрует мерджи).
- Убираются строки с `Signed-off-by:` в теле коммита.
- Скрипт НЕ включает подробный список всех коммитов (строки типа "All commits (generated ...)" и последующие строки с хешами); он формирует только краткие сводки по категориям (FEATURES / BUG FIXES / ...). Полная история всегда доступна в git.
- Включаются только «существенные» коммиты по эвристике:
  - явные conventional commit type: `feat`, `fix`, `perf`, `security`, `revert` -> включаются;
  - коммиты, содержащие ссылки на issue/PR (`#1234`), как правило, включаются;
  - коммиты с глаголами, указывающими на функциональные изменения (`add`, `support`, `implement`, `fix`, `remove`, `upgrade`, `update`, `introduce`, `improve`, и т.п.) — включаются;
  - коммиты с префиксами `chore`, `docs`, `style`, `test`, `ci`, `format`, `lint`, `bump` — по умолчанию НЕ считаются существенными и не включаются.
- Если для тега не остаётся ни одного существенного коммита, для этой версии запись НЕ добавляется (пропускается).

Если хочется изменить критерии существенности — редактируйте функцию `isSubstantialCommit` в `common/scripts/update-changelog.js` и запустите dry-run.

---

## Примечания и рекомендации по ревью

- Скрипт формирует краткие сводки (по категориям FEATURES / BUG FIXES / PERFORMANCE / SECURITY / MISCELLANEOUS).
  При необходимости поправьте текст вручную (например, объедините похожие пункты, исправьте формулировки).
- Проверьте, что важные изменения не пропали из-за агрессивной фильтрации. Если нужно включить конкретный коммит —
  добавьте его вручную в сгенерированный раздел.
- Если необходимо, удалите лишние секции или добавьте поясняющие строки (например, ссылки на релизные задачи).
- Используйте привычный шаблон коммита для `changelog.md`:
  ```
  chore(changelog): update changelog for vX.Y.Z .. vA.B.C
  ```

---

## Отладка / частые проблемы

- Скрипт не находит теги на `origin`:
  - Проверьте `git remote -v`.
  - Выполните `git ls-remote --tags origin` вручную для диагностики.
- Скрипт не находит «якорный» (последний) тег из `changelog.md`:
  - Проверьте, что версия из `changelog.md` действительно соответствует тегу вида `vX.Y.Z` на `origin`.
  - При необходимости воспользуйтесь флагом `--from <X.Y.Z>`.
- Если изменения получились неожиданными — отмените правки:
  ```
  git restore changelog.md
  ```
  (или `git checkout -- changelog.md` на старых версиях Git)

---

## Пример команды для ручной генерации списка коммитов (как справочная команда)
(тот же принцип фильтрации как в скрипте — исключить `Merge remote-tracking` и удалить подписи):
```
git log --pretty=format:'- %h %s' v0.7.318..v0.7.319 \
  | grep -v -F 'Merge remote-tracking' \
  | sed -E 's/\\s*Signed-off-by:.*$//'
```

---

## Контроль качества

1. Запустить dry-run и проверить сформированные блоки.
2. Привести текст к общему стилю (при необходимости вручную).
3. Прогнать форматтер / линтер (если применимо): `pnpm run format --force` или сходный инструмент в репозитории.
4. Сделать PR и дождаться ревью.

---

Если появятся вопросы по критериям включения коммитов или по форматированию разметки — пишите мне/релизной команде и мы согласуем правила.
