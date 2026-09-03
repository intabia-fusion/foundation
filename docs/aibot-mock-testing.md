# Локальная проверка ЮляИИ на моке

Мок-провайдер (`services/ai-bot/pod-ai-bot/src/llms/mock.ts`) - детерминированная offline-модель.
Сети нет, usage фиксированный, поэтому биллинг и оконные лимиты ведут себя как с настоящей моделью.
Нужен, чтобы гонять UI-сценарии карточек предложений без локального model server.

## Как включить

Мок живёт на **собственном уровне `mock`** ("Мок" в UI). Правки yaml и рестарта не нужно:
переключение - это выбор уровня в настройках.

Так сделано потому, что уровень обязан иметь ровно одного провайдера: при двух включённых
провайдерах на один уровень под падает на старте с
`AI config error: level 'low' is served by both 'openai' and 'mock'`
(`services/ai-bot/pod-ai-bot/src/config.ts:380-393`). Отдельный уровень снимает конфликт, и
`openai` (реальная локальная модель) остаётся включённым рядом.

Маршрут: клиентский воркер `aibot_client_llm` держит `mock` на провайдере `mock`
(`dev/config-aibot-client.yaml`), а серверный `clisr` отдаёт этот уровень тому же воркеру
(`dev/config-aibot.yaml`). Модель-сервер на хосте для уровня `mock` не нужен.

**Настройки -> ЮляИИ -> вкладка "Основные" -> Мок.**

Если dev-стенд уже поднят со старыми конфигами - перечитать их:

```bash
docker compose -f dev/docker-compose.yaml up -d aibot aibot_client_llm --force-recreate
docker compose -f dev/docker-compose.yaml logs aibot_client_llm | grep -i mock
# ждём: "Mock LLM provider configured"
```

REST-путь для смены уровня требует системного токена (`generateToken(systemAccountUuid, workspace, ...)`),
руками из curl его не собрать - готовый хелпер в `tests/sanity/tests/API/AiBot.ts:30`
(`POST <base>/levels/workspace`, тело `{"level":"mock"}`, воркспейс берётся из токена).
Префикс различается: в dev-стенде `/_ai` (`dev/nginx.conf:194`), в sanity-стенде `/_aibot`
(`tests/nginx.conf:136`).

### Почему не уровень `low`

У `low` в `dev/config-aibot.yaml` стоит `features: { talk: false, summary: false, tasks: false }` -
тулы `propose_task` / `edit_issue_draft` модели на нём вообще не отдаются, и карточка предложения
не появится. У `mock` блока `features` нет специально, поэтому все тулы доступны.

### Настройки мока

Параметры - в `endpointConfig` провайдера `mock` (`dev/config-aibot-client.yaml`):
`echo` (добавлять к ответу дамп полученного контекста), `reply` (ответ для summary),
`promptTokens` / `completionTokens` (фиксированный usage). `tokenMultiplier: 0` у уровня означает,
что прогон не тратит месячное окно воркспейса; поставьте ненулевой, если проверяете лимиты.

## Протокол мока

Мок понимает три вещи.

**Команды-сценарии** (первой строкой сообщения). Каждая мапится на первый доступный в контексте тул,
поэтому одна и та же команда работает в треде документа, треде задачи и в диалоге создания задачи:

| Команда | Что проверяет | Тул |
|---|---|---|
| `propose_text` + текст следующими строками | карточка предложения по тексту (дифф) | `propose_new_document`, в черновике - `edit_issue_draft.description` |
| `propose_issue <название>` | карточка задачи с текстом-заглушкой | `propose_task`, в черновике - `edit_issue_draft` |
| `split_issues <N>` | карточка подзадач, N случайных (1..10) | `propose_subtasks`, иначе `propose_task.subtasks` |

**Справка.** Любое другое сообщение без `call:` - ответ "Мок-модель": команды выше с примерами
(недоступные в этом контексте помечены) и список тулов контекста с параметрами.

**Echo.** При `endpointConfig.echo: true` к меню добавляется markdown-дамп всего, что провайдер
получил: секции `### mode`, `### prompt`, `### history (N)`, `### shared`, `### personal`,
`### tools (N)`. Видно, какие тулы реально дошли до модели и какой контекст собрался.

**Сырые вызовы тулов** (когда нужны конкретные аргументы). Строка вида `call:<tool_name> {json}`
**на отдельной строке** в сообщении заставляет мок вызвать этот тул с этими аргументами
(`mock.ts:26` - `TOOL_CALL_RE`). Несколько `call:` подряд выполняются по очереди.

Ограничения регулярки: JSON должен быть **в одну строку** (переносы внутри markdown - как `\n`
внутри JSON-строки) и **не содержать `}`** до своего конца - совпадение не-жадное и оборвётся
на первой закрывающей скобке.

## Команды для проверки конкретных правок

Открыть тред: кнопка "Обсудить с ЮляИИ" (`btnDiscussWithAI`) в шапке задачи/документа.
Всё ниже вставляется в поле ввода треда одним сообщением.

### 1. Карточка задачи с подзадачами - `TaskProposalPresenter`

Проверяет: сворачивание через `Expandable`, `SubtaskSection`, `SpaceSelector` без своего запроса
проектов, создание задач.

```
сделай задачу
call:propose_task {"title":"Перевести биллинг на новый провайдер","description":"Текущий провайдер не отдаёт вебхуки по возвратам.","priority":"high","estimation":16,"subtasks":[{"title":"Описать контракт вебхуков","estimation":2},{"title":"Реализовать адаптер","description":"С ретраями и идемпотентностью","priority":"high","estimation":8},{"title":"Миграция ключей","estimation":3},{"title":"Прогнать e2e","estimation":3}]}
```

Что смотреть:
- заголовок карточки со стрелкой - клик сворачивает и разворачивает тело (это `Expandable`);
- список подзадач с чекбоксами, все отмечены;
- селектор проекта - выпадает список проектов и кнопка "Create task" активна **без** отдельного
  запроса проектов из презентера (проект подставляется автоселектом `SpaceSelector`);
- после создания - кнопка "Task created", отмеченные строки помечены выполненными,
  в тело сообщения дописаны ссылки на созданные задачи.

Разбить существующую задачу (тред должен быть привязан к задаче):

```
разбей на подзадачи
call:propose_subtasks {"subtasks":[{"title":"Часть 1"},{"title":"Часть 2"},{"title":"Часть 3"}]}
```

### 2. Большой дифф документа - `EditProposalPresenter`

Проверяет: `ShowMore` вместо фиксированного `max-height: 20rem`.

Открыть документ (Документы -> любой), нажать "Обсудить с ЮляИИ", отправить:

```
перепиши документ
call:propose_new_document {"markdown":"# Архитектура\n\n## Контекст\n\nСервис принимает вебхуки от банка и раскладывает их по очередям.\n\n## Проблема\n\nОчередь не идемпотентна, повтор вебхука создаёт вторую подписку.\n\n## Решение\n\nДедупликация по idempotency key на входе.\n\n### Шаг 1\n\nДобавить таблицу processed_events с TTL 30 дней.\n\n### Шаг 2\n\nПисать ключ в той же транзакции, что и эффект.\n\n### Шаг 3\n\nОтдавать 200 на повтор, не выполняя эффект.\n\n### Шаг 4\n\nМетрика webhook_duplicates_total.\n\n### Шаг 5\n\nАлерт при росте дублей больше 5 процентов.\n\n## Риски\n\nРост таблицы, нужен фоновый вакуум.\n\n## Откат\n\nФича-флаг idempotency_enabled, выключается без деплоя.\n\n## Сроки\n\nДве недели на реализацию, неделя на раскатку.\n\n## Ответственные\n\nКоманда платежей.\n"}
```

Что смотреть:
- дифф обрезан, снизу ссылка "Show more" / "Показать больше";
- клик разворачивает целиком, надпись меняется на "Show less";
- кнопка "Применить" пишет предложение в открытый документ, карточка переходит в "Применено".

Только переименование (диффа нет, кнопка применения работает по `proposedTitle`):

```
переименуй
call:rename_document {"title":"Идемпотентная обработка вебхуков"}
```

### 3. Панель ассистента в диалоге создания задачи - `IssueAssistPanel`

Проверяет: `edit_issue_draft` и применение предложения в форму.

Трекер -> "+ Новая задача" -> кнопка с иконкой ЮляИИ в шапке диалога (`btnIssueAssist`), затем:

```
поправь черновик
call:edit_issue_draft {"title":"Идемпотентная обработка вебхуков","description":"Повтор вебхука не должен создавать вторую подписку.","priority":"urgent","estimation":8}
```

Что смотреть: карточка в панели, кнопка "Применить" переносит поля в форму слева.

### 4. Настройки уровней - `AILevelCards`

Настройки -> ЮляИИ -> вкладка "Основные". Карточки уровней теперь `ModernButton`
(`data-id="btnAiLevel-<level>"`): выбранный - `primary` + `pressed`, при `readonly` (не Owner) все
задизейблены. Выбор сохраняется в `AISpaceSettings` и переживает перезагрузку.

## Playwright

Сценарии живут в `tests/sanity/tests/chat/ai-bot-scenarios.spec.ts` и используют тот же протокол
`call:<tool> {json}`. Стенд для них поднимается обычным путём, aibot входит в него всегда
(`tests/docker-compose.yaml`, сервис `aibot` c `tests/config-aibot.yaml`, уровень `low` = мок в echo-режиме).

```bash
cd tests && ./prepare-pg
cd sanity
rushx uitest -g 'ai-bot scenarios' --reporter=list --workers=1
```

Отдельные новые проверки:

```bash
rushx uitest -g 'task proposal card folds and unfolds' --reporter=list
rushx uitest -g 'a long proposed document is cropped behind show more' --reporter=list
rushx uitest -g 'AI level cards switch the workspace level' --reporter=list
```

После правок в `plugins/*` стенд надо пересобрать - `rush fast-build:docker` + `cd tests && ./prepare-pg`,
иначе Playwright гоняет старый бандл.

## data-id для тестов

| data-id | Компонент |
|---|---|
| `btnDiscussWithAI` | `DiscussWithAI.svelte` |
| `aiTaskProposal` | заголовок карточки задачи (`TaskProposalPresenter`) |
| `aiTaskProposalBody` | тело карточки задачи, скрывается при сворачивании |
| `aiEditProposal` | заголовок карточки правки (`EditProposalPresenter`) |
| `btnIssueAssist` | `IssueAssistToggle.svelte` |
| `btnAiNewContext`, `btnAiExportChat` | `ThreadContextActions.svelte` |
| `btnAiLevel-<level>` | карточка уровня (`AILevelCards`) |
