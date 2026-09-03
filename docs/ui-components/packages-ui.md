# packages/ui - каталог компонентов

Справочник публично экспортируемых компонентов `@hcengineering/ui` (`packages/ui/src/components`, по `packages/ui/src/index.ts`). Иконки (`icons/`, `calendar/icons/`, `internal/icons/`, ~90 штук `IconXxx`) в таблицы не включены.

## Buttons & actions

| Component | Purpose | Key props |
|---|---|---|
| Button | Универсальная кнопка старого стиля | `label`, `kind`, `size`, `icon`, `iconRight` |
| HeaderButton | ButtonWithDropdown для шапки с проверкой прав | `mainActionId`, `client`, `actions`, `visibleActions`, `loading` |
| ButtonWithDropdown | Кнопка+стрелка, popup выбора из dropdownItems | `dropdownItems`, `label`, `kind`, `icon`, `dropdownIcon` |
| ButtonGroup | Кнопки в сегментированной группе с select-режимом | `items`, `selected`, `allowDeselected`, `mode` |
| ButtonIcon | Кнопка-иконка без текста, modern-стиль | `kind`, `size`, `icon`, `disabled`, `pressed` |
| ButtonMenu | Кнопка, открывающая dropdown-список items | `items`, `selected`, `kind`, `size`, `label` |
| ButtonBase | Примитив кнопки, напрямую не используется | `kind`, `size`, `type`, `icon`, `label` |
| ModernButton | Modern-аналог Button, дефолт для нового UI | `kind`, `size`, `shape`, `icon`, `label` |
| SplitButton | Кнопка из двух независимо кликабельных половин | `label`, `secondTitle`, `icon`, `secondIcon`, `action` |
| CircleButton | Круглая кнопка-иконка для плавающих элементов | `icon`, `size`, `ghost`, `selected`, `primary` |
| ActionIcon | Inline иконка-кнопка с async action и keys | `label`, `icon`, `size`, `action`, `keys` |
| ToggleButton | Кнопка-переключатель boolean с selected-подсветкой | `value`, `label`, `icon`, `size`, `selected` |
| StatusBarButton | Кнопка-иконка для статус-бара | `icon`, `iconProps`, `pressed`, `id`, `element` |
| FilterButton | Кнопка попапа фильтров, показывает активные фильтры | `categories`, `activeFilters`, `disabled`, `size`, `kind` |
| Chevron | Иконка-шеврон expand/collapse, индикатор направления | `size`, `fill`, `expanded`, `direction`, `outline` |
| Like | Виджет лайка (иконка+счетчик) с состоянием voted | `value`, `voted` |

## Inputs & editors

| Component | Purpose | Key props |
|---|---|---|
| EditBox | Базовый однострочный/многострочный ввод legacy | `value`, `format`, `kind`, `maxWidth`, `disabled` |
| ModernEditbox | Modern-аналог EditBox, дефолт для нового UI | `value`, `kind`, `size`, `disabled`, `password` |
| StylishEdit | Легкая обертка input с error-подсветкой | `value`, `error`, `password`, `width`, `disabled` |
| TextArea | Многострочный textarea legacy-дизайна | `value`, `width`, `height`, `wrap`, `disabled` |
| TextAreaEditor | TextArea с кнопками submit/cancel | `value`, `inputRef`, `submitLabel`, `width`, `height` |
| PlainTextEditor | Растущий textarea без оформления | `value`, `placeholder`, `disabled` |
| EditWithIcon | Поле с иконкой слева, база для SearchEdit | `icon`, `value`, `kind`, `size`, `loading` |
| SearchEdit | Поиск на EditWithIcon, debounce 500ms | `value`, `width`, `kind` |
| SearchPicker | Поиск с мультивыбором, значения - чипы (tag-input) | `value`, `items`, `placeholder`, `autoFocus` |
| SearchInput | Поиск, схлопывается в иконку для toolbar | `value`, `collapsed`, `delay`, `kind`, `width` |
| NumberInput | Числовой ввод с кнопками +/-, min/max | `value`, `minValue`, `maxValue`, `maxDigitsAfterPoint`, `disabled` |
| CodeForm | Форма полей кода (OTP), валидация paste | `fields`, `size`, `kind`, `padding`, `minHeight` |
| CodeInput | Одно поле символа кода внутри CodeForm | `value`, `size`, `kind`, `id`, `name` |
| Html | Рендерит HTML после санитизации DOMPurify | `value` |
| Label | Переводит IntlString через translateCB | `label`, `params` |
| Chip | Удаляемый тег с меткой/фоном/tooltip, база для SearchPicker | `label`, `size`, `isRemovable`, `backgroundColor`, `tooltip` |
| Hotkey | Одна клавиша горячей комбинации | `key` |
| HotkeyGroup | Последовательность клавиш (набор Hotkey) | `keys` |
| TimeShiftPicker | Пикер сдвига времени с popup-календарем | `title`, `value`, `show`, `direction` |
| TimeShiftPresenter | Форматирует сдвиг времени в строку "через/назад X" | `value`, `exact` |
| Toggle | Простой on/off переключатель без текста | `id`, `on`, `disabled`, `showTooltip` |
| ModernToggle | Modern-переключатель с size/label/background | `title`, `label`, `size`, `checked`, `disabled` |
| ToggleWithLabel | Toggle с обязательным label и description | `label`, `description`, `on`, `disabled` |
| MiniToggle | Уменьшенная версия Toggle | `label`, `on`, `disabled` |
| Switcher | Группа сегментов/вкладок (не boolean on/off) | `items`, `selected`, `kind`, `name`, `onlyIcons` |
| SwitcherBase | Примитив элемента Switcher, отдельно не используется | `id`, `icon`, `label`, `badge`, `kind` |
| CheckBox | Чекбокс с цветовыми kind и вариантом circle | `checked`, `symbol`, `size`, `circle`, `kind` |
| ModernCheckbox | Modern-чекбокс с indeterminate/error состояниями | `label`, `labelIntl`, `checked`, `indeterminate`, `error` |
| RadioButton | Радио-кнопка старого стиля (group/value) | `group`, `value`, `label`, `labelIntl`, `kind` |
| RadioGroup | Список RadioButton с общим selected | `items`, `selected`, `disabled`, `gap` |
| ModernRadioButton | Modern radio-кнопка с явным checked и error | `group`, `value`, `checked`, `label`, `disabled` |
| BooleanIcon | Неинтерактивный SVG-индикатор true/false/null | `value` |

## Selection / dropdowns / popups

| Component | Purpose | Key props |
|---|---|---|
| Dropdown | Кнопка-триггер старого дизайна для DropdownPopup | `items`, `selected`, `placeholder`, `kind`, `size` |
| DropdownPopup | Контент Dropdown: поиск + ListView по ListItem[] | `items`, `icon`, `placeholder`, `withSearch`, `selectedId` |
| DropdownLabels | Кнопка-триггер, DropdownTextItem[] с multiselect | `items`, `selected`, `multiselect`, `placeholder`, `kind` |
| DropdownLabelsPopup | Контент DropdownLabels (DropdownTextItem[]) | `items`, `selected`, `multiselect`, `enableSearch`, `placeholder` |
| DropdownLabelsIntl | Как DropdownLabels, но items - DropdownIntlItem | `items`, `selected`, `multiselect`, `label`, `kind` |
| DropdownLabelsPopupIntl | Контент DropdownLabelsIntl, поиск через translate() | `items`, `selected`, `multiselect`, `withSearch`, `searchPlaceholder` |
| DropdownRecord | Дропдаун поверх Record<key, IntlString> (не массив) | `items`, `selected`, `kind`, `size`, `width` |
| ModernDropdown | Modern-аналог DropdownLabelsIntl на ModernButton | `items`, `selected`, `multiselect`, `kind`, `size` |
| ModernDropdownLabels | Modern-аналог DropdownLabels (DropdownTextItem[]) | `items`, `selected`, `multiselect`, `enableSearch`, `showContent` |
| ModernPopupLabels | Modern-контент для DropdownTextItem[] | `items`, `selected`, `multiselect`, `enableSearch`, `placeholder` |
| ModernPopup | Modern-контент для DropdownIntlItem[] | `items`, `selected`, `multiselect`, `withSearch`, `searchPlaceholder` |
| SelectPopup | Контент выбора, вызывается через showPopup+onSelect | `value`, `onSelect`, `searchable`, `width`, `size` |
| ColorPopup | Попап выбора из {id,color,label}, для цветов | `value`, `selected`, `searchable`, `placeholder` |
| PopupMenu | Позиционирование попапа через ручной prop show | `show`, `margin` |
| Popup | Хост showPopup(), рендерит попапы из popupstore | `contentPanel`, `fullScreen` |
| PopupInstance | Рендерит одно попап-окно внутри Popup.svelte | `is`, `props`, `element`, `onClose`, `overlay` |
| Menu | Список Action[] с клавиатурной навигацией | `actions`, `ctx`, `popupCategory`, `addClass` |
| Submenu | Открывает вложенное Menu через tooltip-механизм | `component`, `props`, `options`, `icon`, `label` |
| NestedMenu | Дерево категория+дочерние элементы через Submenu | `items`, `nestedFrom`, `onSelect`, `withIcon`, `withSearch` |
| NestedDropdown | Кнопка-триггер, открывает попап NestedMenu | `items`, `selected`, `label`, `kind`, `withIcon` |
| NestedSelectPopup | Дерево NestedSelectItem, рекурсивный, toggle onChange | `items`, `selectedValues`, `onChange`, `placeholder`, `isTopLevel` |
| FilterCategoryPopup | Навигация FilterCategory -> FilterOption | `categories`, `activeFilters`, `onFilterChange`, `onFilterRemove` |

## Layout & containers

| Component | Purpose | Key props |
|---|---|---|
| Grid | CSS-grid обертка с колонками и отступами | `column`, `rowGap`, `columnGap`, `equalHeight`, `alignItems` |
| Row | Обертка-строка на всю ширину grid-родителя | - (props нет) |
| Section | Секция страницы с заголовком и слотами header/content | `label`, `icon`, `showHeader`, `spaceBeforeContent`, `high` |
| SectionEmpty | Плейсхолдер "пусто" внутри секции | `icon`, `label`, `labelParams` |
| Scroller | Скролл-контейнер с кастомным скроллбаром, fade | `vertical`/`horizontal`, `autoscroll`, `fade`, `buttons`, `stickedScrollBars` |
| ScrollBox | Overflow-бокс без скроллбара, легче Scroller | `vertical`, `stretch`, `bothScroll`, `autoscrollable` |
| ScrollerBar | Полоса прокрутки для внешнего scroller-элемента | `scroller`, `gap`, `padding` |
| Separator | Разделитель панелей, размер хранится в localStorage | `name`, `index`, `separatorSize`, `float`, `short` |
| Fold | Иконка-стрелка раскрытия, не контейнер | `isOpen`, `empty`, `level` |
| ExpandCollapse | Обертка show/hide по флагу, без UI-триггера | `isExpanded` |
| Expandable | Блок заголовок+шеврон+ExpandCollapse-содержимое | `icon`, `label`, `expanded`, `bordered`, `expandable` |
| AccordionItem | Элемент аккордеона с counter/duration, вложенность | `id`, `label`, `size`, `isOpen`, `kind` |
| ShowMore | Обрезка контента по высоте с кнопкой "показать больше" | `limit`, `ignore`, `fixed`, `bigger` |
| Panel | Боковая панель с ресайзом через Separator | `isHeader`, `isAside`, `isFullSize`, `floatAside`, `customAside` |
| PanelInstance | Runtime-обертка Panel для showPanel API | `contentPanel`, `embedded`, `readonly` |
| Timeline | Таймлайн со строками, чекбоксами, текущим временем | `selectedRows`, `selectedRow`, `lines`, `currentTime` |

## Navigation

| Component | Purpose | Key props |
|---|---|---|
| Header | Шапка с адаптивным схлопыванием search/actions/extra | `type`, `adaptive`, `hideSearch`, `hideActions`, `doubleRowWidth` |
| TabList | Вкладки со скроллом, multiselect и иконками | `selected`, `items`, `kind`, `multiselect`, `onlyIcons` |
| Tabs | Вкладки + рендер Component поверх TabsControl | `model`, `selected`, `padding`, `size` |
| TabsControl | Низкоуровневый рендер полосы вкладок, внутри Tabs | `model`, `selected`, `gap`, `maxTabWidth` |
| NavItem | Элемент дерева навигации в сайдбаре | `icon`, `label`, `selected`, `count`, `level` |
| NavGroup | Сворачиваемая группа NavItem с контекстным меню | `label`, `categoryName`, `isOpen`, `type`, `actions` |
| Breadcrumb | Один элемент хлебных крошек | `icon`, `label`, `size`, `isCurrent` |
| Breadcrumbs | Список Breadcrumb с шевронами и выбором | `items`, `size`, `selected`, `currentOnly` |
| ModernTab | Вкладка нового дизайна с close-кнопкой | `label`, `icon`, `highlighted`, `orientation`, `canClose` |

## Feedback & status

| Component | Purpose | Key props |
|---|---|---|
| Status | Статус Severity (OK/WARNING/ERROR), для OK не рендерит | `status`, `overflow` |
| StatusBadge | Точка-индикатор Severity с тултипом вместо текста | `status`, `overflow`, `multicolor`, `tooltip` |
| StateTag | Тег кастомного именованного состояния сущности | `type`, `label`, `params` |
| ErrorPresenter | Иконка ошибки с тултипом через ErrorPopup | `error` |
| Loading | Обертка над Spinner с задержкой показа и подписью | `shrink`, `label`, `size`, `color` |
| Spinner | Низкоуровневый анимированный индикатор загрузки | `size`, `color` |
| Progress | Прогресс-бар, редактируется перетаскиванием мышью | `value`, `min`, `max`, `color`, `editable` |
| ProgressCircle | Кольцевой индикатор прогресса с заполнением по дуге | `value`, `min`, `max`, `color`, `size` |
| MultiProgress | Прогресс-бар из нескольких цветных сегментов | `values`, `min`, `max` |
| BarDashboard | Дашборд строк MultiProgress, отрисованных как grid | `items` |
| NotificationToast | Тост-уведомление с иконкой severity и заголовком | `onClose`, `severity`, `title` |
| Notifications | Портал, рендерит очередь тостов по 4 углам экрана | - (данные из `notificationsStore`) |
| ModeSelector | Переключатель режимов поверх Switcher из конфига IModeSelector | `props`, `kind`, `onlyIcons`, `expansion`, `padding` |

## Date & time

| Component | Purpose | Key props |
|---|---|---|
| DatePicker | DatePresenter с заголовком и режимом date/datetime | `title`, `value`, `withTime`, `iconModifier`, `labelNull` |
| DateRangePicker | Пикер поверх DateRangePresenter, всегда режим DATETIME | `title`, `value`, `iconModifier`, `labelNull` |
| DatePopup | Попап даты: ввод + два грида MonthSquare + Shifts | `currentDate`, `withTime`, `label`, `detail`, `noShift` |
| SimpleDatePopup | Упрощенный попап, только грид Month, без времени | `currentDate`, `timeZone` |
| RangeDatePopup | Попап диапазона дат (from/to) через два MonthSquare | `startDate`, `endDate`, `label` |
| DateRangePopup | Попап перехода: грид Month + относительные сдвиги | `direction`, `minutes`, `hours`, `days`, `shift` |
| TimePopup | Кнопки относительного сдвига времени, без грида дат | `value` |
| DateRangePresenter | Презентер даты с широким набором стилей (kind/size/avatar) | `value`, `mode`, `editable`, `kind`, `size` |
| DateTimeRangePresenter | Обертка над DateRangePresenter с принудительным mode=DATETIME | `value`, `editable`, `iconModifier`, `labelNull`, `noShift` |
| DatePresenter | Базовый презентер-кнопка даты/времени, открывает DatePopup | `value`, `mode`, `editable`, `icon`, `kind` |
| DueDatePresenter | Презентер due date с overdue-стилизацией и своим DueDatePopup | `value`, `shouldRender`, `onChange`, `kind`, `editable` |
| DateTimePresenter | Обертка над DatePresenter с принудительным mode=DATETIME | `value`, `editable` |
| TimeInputBox | Ручной ввод часов/минут, не грид и не попап | `currentDate`, `size`, `noBorder`, `disabled`, `timeZone` |
| MonthCalendar | Грид дней одного месяца, блок для YearCalendar | `weekFormat`, `cellHeight`, `selectedDate`, `currentDate`, `displayedWeeksCount` |
| YearCalendar | Грид всего года - 12 экземпляров MonthCalendar подряд | `selectedDate`, `currentDate`, `cellHeight`, `minWidth` |
| WeekCalendar | Недельная сетка: колонки дней x строки часов (agenda) | `cellHeight`, `selectedDate`, `currentDate`, `displayedDaysCount`, `displayedHours` |
| MonthSquare | Грид месяца с выделением диапазона (selectedTo) | `currentDate`, `viewDate`, `displayedWeeksCount`, `timeZone`, `selectedTo` |
| Month | Грид месяца со слотами дня, без range-логики | `currentDate`, `timeZone`, `hideNavigator`, `replacementDay` |
| SimpleTimePopup | Минимальный попап только для ввода времени | `currentDate` |

## Media & misc

| Component | Purpose | Key props |
|---|---|---|
| Component | Загрузка компонента по AnyComponent-ссылке | `is`, `props`, `shrink`, `showLoading`, `inline` |
| Icon | Рендерер иконки любого типа (Asset или Svelte-компонент) | `icon`, `size`, `iconProps`, `fill` |
| Link | Ссылка с иконкой, обрезает длинные имена файлов | `label`, `icon`, `disabled`, `maxLenght` |
| LinkWrapper | Превращает URL в тексте в кликабельные ссылки | `text`, `label`, `params` |
| TimeSince | Текст relative time от значения до текущего момента | `value`, `kind` |
| TimeLeft | Обратный отсчет до Timestamp, событие при истечении | `time`, `showHours` |
| TimeZonesPopup | Попап выбора и управления списком часовых поясов | `selected`, `timeZones`, `count`, `reset`, `withAdd` |
| Blurhash | Blurhash как canvas-превью, плейсхолдер до загрузки | `blurhash`, `width`, `height`, `punch` |
| Dock | Контейнер докнутого компонента из dockStore | - (данные из `dockStore`) |
| Image | Тег img с retry при ошибках загрузки | `src`, `srcset`, `alt`, `width`, `height` |
| Video | Обертка над плеером Plyr для воспроизведения видео | `src`, `name`, `poster`, `preload` |
| EmbeddedHTML | HTML по URL как blob, встраивает через EmbeddedPDF/iframe | `src`, `name`, `fit`, `css` |
| EmbeddedPDF | PDF/HTML в iframe с инъекцией CSS в contentDocument | `src`, `name`, `fit`, `css` |
| Lazy | Ленивая отрисовка слота через IntersectionObserver | - (props нет, только слоты) |
| WorkspaceLogo | Логотип воркспейса с буквой-заглушкой | `mini`, `name`, `accent`, `notify`, `logoUrl` |
| AppLoading | Экран загрузки на базе Loading, с событием progress | `shrink`, `label`, `size` |
| FocusHandler | Перехватывает Tab для управления фокусом через FocusManager | `manager`, `isEnabled` |
| ListView | Виртуализированный список строк с выделением | `selection`, `count`, `kind`, `items`, `lazy` |
| TooltipInstance | Рендерер активного тултипа/попапа, подписан на tooltipstore | `fullScreen` |
| AccentPreview | Превью демо-контролов при наведении на accent-цвет темы | `accent`, `anchorRect`, `usePopupStyle` |
| PreviewControls | Демо-контролы, показывающие влияние акцента для AccentPreview | `accent` |

## Modal/dialog system

| Component | Purpose | Key props |
|---|---|---|
| Modal | Модальный/aside-контейнер старого дизайна с ok/cancel футером | `type`, `width`, `okAction`, `okLabel`, `adaptive` |
| Dialog | Самый старый контейнер: заголовок, close/maximize, без футера | `label`, `isFullSize`, `padding` |
| ModernDialog | Диалог нового дизайна с submit/cancel футером и back-кнопкой | `label`, `submitLabel`, `canSubmit`, `hasBack`, `loading` |
| StepsDialog | Многошаговый диалог поверх Panel с боковой панелью шагов | `steps`, `stepIndex`, `doneLabel`, `title`, `allowClose` |
| Wizard | Мастер поверх ScrollerBar: лента шагов + текущий компонент | `items`, `selected`, `gap` |
| ModernWizardDialog | Мастер поверх ModernDialog с прогресс-баром и back/next | `label`, `steps`, `selectedStep`, `canProceed`, `submitLabel` |
| ModernWizardBar | Полоса прогресса шагов (номера/чекмарки) для ModernWizardDialog | `steps`, `selectedStep` |

## Low-level / internal

Не экспортируются из `@hcengineering/ui` (внутренние части других компонентов): `DropdownRecordPopup.svelte`, `ErrorPopup.svelte`, `FilterOptionPopup.svelte`, `ListViewItem.svelte`, `MouseSpeedTracker.svelte`, `RootStatusComponent.svelte`, `SelectBox.svelte`, `TimeShiftPopup.svelte`, `calendar/DateInputBox.svelte`, `calendar/DueDatePopup.svelte`, `calendar/Shifts.svelte`, `internal/Clock.svelte`, `internal/ClockFace.svelte`, `internal/ClockPopup.svelte`, `internal/ConnectionStatus.svelte`, `internal/ConnectionStatusPopup.svelte`, `internal/ErrorComponent.svelte`, `internal/Root.svelte`, `internal/RootBarExtension.svelte`, `internal/Settings.svelte`, `internal/SettingsPopup.svelte`, `internal/ThemeButton.svelte`, `notifications/Notification.svelte`, `wizard/WizardStep.svelte`.

## Выбор между похожими

- **Button vs ModernButton vs ButtonBase**: ButtonBase - примитив, не используется напрямую; Button - старый дизайн (legacy kind) для существующего UI; ModernButton - новый дизайн (primary/secondary/tertiary/negative) для нового UI.
- **EditBox vs ModernEditbox vs StylishEdit vs TextArea**: EditBox - старый ввод через `format`; ModernEditbox - новый дизайн (`kind`/`size`); StylishEdit - облегченная версия, только error-стейт; TextArea - выделенный multiline legacy-дизайна (`width`/`height`/`wrap`).
- **Dropdown vs DropdownLabels vs ModernDropdown vs SelectPopup**: Dropdown/DropdownLabels - кнопки-триггеры старого дизайна (ListItem vs DropdownTextItem+multiselect); ModernDropdown - новый дизайн, аналог DropdownLabelsIntl; SelectPopup - не кнопка, а сам попап-контент, вызывается вручную через `showPopup`+`onSelect`.
- **Popup vs Modal vs Dialog vs ModernDialog**: Popup - хост-фреймворк `showPopup()` (не импортируется напрямую); Dialog - самый старый контейнер, без футера; Modal - контейнер с ok/cancel футером старого дизайна; ModernDialog - текущий стандарт для форм-модалок (submit/cancel, back, loader).
- **Toggle vs MiniToggle vs ModernToggle vs Switcher**: Toggle - простой on/off старого стиля без текста; MiniToggle - уменьшенная версия Toggle; ModernToggle - новый дизайн (size/label/background); Switcher - не boolean-переключатель, а группа сегментов/вкладок.
- **CheckBox vs ModernCheckbox**: CheckBox - старый стиль (цветовые kind, вариант circle); ModernCheckbox - новый дизайн с indeterminate/error и обязательным label.
- **Section vs AccordionItem vs Expandable vs Fold vs ExpandCollapse vs ShowMore**: Fold - только иконка-стрелка (не контейнер); ExpandCollapse - голая обертка show/hide без UI-триггера; Expandable - готовый блок заголовок+шеврон+контент; AccordionItem - полноценный элемент аккордеона (counter/duration/nested) для списков; Section - секция страницы с заголовком, крупнее прочих, для настроек; ShowMore - обрезка длинного текста по высоте, не про открытие/закрытие блока.
