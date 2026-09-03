# Каталог UI-компонентов

Справочник по тому, что уже есть в платформе, чтобы не писать своё. Перед созданием нового `.svelte`-компонента
в плагине - искать здесь.

| Документ | Что внутри |
|---|---|
| [packages-ui.md](packages-ui.md) | `@hcengineering/ui` - 155 публичных компонентов: кнопки, поля, дропдауны, попапы, layout, навигация, статусы, даты. Плюс раздел "Выбор между похожими" (Button vs ModernButton, EditBox vs ModernEditbox, Popup vs Modal vs Dialog и т.д.) |
| [packages-presentation.md](packages-presentation.md) | `@hcengineering/presentation` - работа с клиентом и данными (`getClient`, `createQuery`, `LiveQuery`), просмотр контента (`MessageViewer`, `FilePreview`), выбор объектов и пространств, карточки, атрибуты, файлы |
| [view-resources.md](view-resources.md) | `plugins/view-resources` - презентеры и редакторы атрибутов, таблицы, вьюлеты, фильтры, панели. Плюс реестр `view.component.*` |

## Два способа взять чужой компонент

1. **Прямой import** - `import { Button } from '@hcengineering/ui'`. Годится всегда для `ui` и `presentation`
   (это листовые пакеты). Для `*-resources` тянет их зависимости в bundle и может замкнуть цикл.
2. **`<Component is={plugin.component.X} props={...} />`** - строковый `AnyComponent`-id из model-пакета плагина.
   `.svelte` в bundle потребителя не попадает, циклов не возникает. Единственный рабочий способ, когда
   плагин-источник сам (транзитивно) зависит от потребителя.

Пример из репозитория: `TaskProposalPresenter.svelte` берёт `tracker.component.SubtaskSection` и
`chunter.component.ThreadView` через `Component`, потому что прямой импорт замкнул бы
`ai-bot-resources -> tracker-resources -> chunter-resources -> ai-bot-resources`.

Оговорка: id, объявленные в `models/<plugin>/src/plugin.ts` (а не в `plugins/<plugin>/src/index.ts`), живут в
model-пространстве имён и клиентскому коду недоступны - см. `view.component.MarkupDiffPresenter`.

## Поддержка каталога

Источник таблиц - `index.ts` пакета и блоки `export let` компонента. Каталог правится в том же PR, что и код:

- добавили экспортируемый компонент/API в `packages/ui`, `packages/presentation`, `plugins/view-resources` -
  строка в соответствующую таблицу (назначение в одну фразу, до 5 ключевых props);
- переименовали, удалили, поменяли ключевые props или `view.component.*`-id - обновить строку;
- появился второй похожий компонент - пункт в "Выбор между похожими" (`packages-ui.md`).
