# plugins/view-resources - каталог компонентов

## Механизм доступа

Два способа доступа к компонентам `plugins/view-resources/src/components/*.svelte`:
1. Прямой import из `@hcengineering/view-resources` - тянет пакет в bundle потребителя, риск цикла, если потребитель сам в зависимостях view-resources.
2. `<Component is={view.component.X} props={...} />`, id - строка из `@hcengineering/view` - в bundle тянется только id, циклов не возникает.

Часть компонентов - `internal`: не экспортированы и не зарегистрированы, доступны только относительным путём внутри пакета.

## Реестр view.component.* -> файл

Файл = `<Id>.svelte` в `plugins/view-resources/src/components/`, если не указано иное.

Легенда "Доступ" в таблицах ниже: `import` - только именованный экспорт; `view.component.X` - только через реестр (X указан, если id отличается от имени файла); `both` - оба способа; `internal` - не экспортируется и не зарегистрирован.

- `plugins/view/src/index.ts`: ActionsPopup, ObjectPresenter, EditDoc, SpacePresenter, BooleanTruePresenter, ValueSelector, GrowPresenter (list/GrowPresenter.svelte), DividerPresenter (list/DividerPresenter.svelte), AttachedDocPanel, ObjectMention, SearchSelector, FoldersBrowser (folders/FoldersBrowser.svelte), PersonIdPresenter, PersonIdFilter (filter/PersonIdFilter.svelte), RolePresenter, ReadOnlyNotification, ForbiddenNotification, DatePresenter, DateEditor, SidebarPreviewWidget
- `plugins/view-resources/src/plugin.ts`: ObjectFilter (filter/ObjectFilter.svelte), DateFilter (filter/DateFilter.svelte), ValueFilter (filter/ValueFilter.svelte), ArrayFilter (filter/ArrayFilter.svelte), StringFilter (filter/StringFilter.svelte), TimestampFilter (filter/TimestampFilter.svelte), FilterTypePopup (filter/FilterTypePopup.svelte), ArrayEditor, SpaceTypeSelector, MasterDetailBrowser (masterDetail/MasterDetailBrowser.svelte), NumberEditor, NumberPresenter, IdPresenter
- `models/view/src/plugin.ts`: StringEditor, StringEditorPopup (EditBoxPopup.svelte), StringPresenter, HyperlinkPresenter, HyperlinkEditor, HyperlinkEditorPopup, IntlStringPresenter, FileSizePresenter, MarkupDiffPresenter, MarkupPresenter, BooleanPresenter, BooleanEditor, TimestampPresenter, DateTimePresenter, TableBrowser, RelationshipTableBrowser, YoutubePresenter (linkPresenters/YoutubePresenter.svelte), GithubPresenter (linkPresenters/GithubPresenter.svelte), ClassPresenter, ClassRefPresenter, EnumEditor, EnumArrayEditor, HTMLEditor, CollaborativeHTMLEditor, CollaborativeDocEditor, MarkupEditor, MarkupEditorPopup, ListView (list/ListView.svelte), SpaceRefPresenter, EnumPresenter, StatusPresenter (status/StatusPresenter.svelte), StatusRefPresenter (status/StatusRefPresenter.svelte), PersonArrayEditor, PersonIdFilterValuePresenter (filter/PersonIdFilterValuePresenter.svelte), DateFilterPresenter (filter/DateFilterPresenter.svelte), StringFilterPresenter (filter/StringFilterPresenter.svelte), AudioViewer (viewer/AudioViewer.svelte), ImageViewer (viewer/ImageViewer.svelte), VideoViewer (viewer/VideoViewer.svelte), PDFViewer (viewer/PDFViewer.svelte), TextViewer (viewer/TextViewer.svelte), BaseDocPresenter, MasterDetailView (masterDetail/MasterDetailView.svelte), AssociationPresenter, TreeView, AddRelationPopup (relation/AddRelationPopup.svelte)

## Презентеры примитивов

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| BooleanPresenter.svelte | Чекбокс boolean-значения, только чтение | value, inline | view.component.BooleanPresenter |
| BooleanTruePresenter.svelte | Цветной кружок-индикатор true/false | value, trueColor, falseColor, useInvert | view.component.BooleanTruePresenter |
| DatePresenter.svelte | Кнопка даты, открывает попап редактирования | value, mode, accent, readonly | view.component.DatePresenter |
| DateTimePresenter.svelte | Кнопка даты со временем, без аватара | value, onChange, readonly | view.component.DateTimePresenter |
| TimestampPresenter.svelte | Кнопка-презентер числового timestamp | value, kind, size | both |
| HyperlinkPresenter.svelte | Строковый презентер ссылки, inline-режим | value, inline | view.component.HyperlinkPresenter |
| MarkupPresenter.svelte | Рендер markup-текста только для чтения | value | both |
| MarkupDiffPresenter.svelte | Diff между старым и новым значением markup | value, prevValue, showOnlyDiff | both |
| MarkupPreviewPopup.svelte | Popup полного просмотра значения markup | value | import |
| HTMLPresenter.svelte | Рендер сырого HTML-значения атрибута | value | both |
| EnumPresenter.svelte | Презентер значения EnumOf | value, type, onChange | view.component.EnumPresenter |
| IdPresenter.svelte | Презентер строкового идентификатора | value, attribute, object | view.component.IdPresenter |
| FileSizePresenter.svelte | Кнопка-презентер размера файла | value, kind, size | view.component.FileSizePresenter |
| IntlStringPresenter.svelte | Презентер локализованной строки IntlString | value | view.component.IntlStringPresenter |
| StringPresenter.svelte | Обычный строковый презентер | value, accent, oneLine, maxTextWidth | both |
| NumberPresenter.svelte | Кнопка-презентер числового значения | value, label, kind, attribute | both |
| ClassPresenter.svelte | Презентер названия и иконки класса | value | both |
| ClassRefPresenter.svelte | Презентер ссылки на класс | value, shrink | view.component.ClassRefPresenter |
| RolePresenter.svelte | Презентер роли пространства | value, fullSize | view.component.RolePresenter |
| SpacePresenter.svelte | Презентер объекта Space, иконка и название | value, accent | both |
| SpaceRefPresenter.svelte | Презентер ссылки на Space с автозагрузкой | value, inline, shrink | view.component.SpaceRefPresenter |
| AssociationPresenter.svelte | Презентер связи-ассоциации | value | view.component.AssociationPresenter |
| status/StatusPresenter.svelte | Презентер статуса, иконка и цвет | value, size, icon | both |
| status/StatusRefPresenter.svelte | Презентер ссылки на Status, грузит объект по id | value, size, icon | both |

## Редакторы атрибутов

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| StringEditor.svelte | Текстовый редактор строки | value, onChange, kind, editKind | both |
| EditBoxPopup.svelte | Popup строки/числа/пароля с валидацией min/max | value, format, kind, minValue, maxValue | both (export: EditBoxPopup, id: StringEditorPopup) |
| NumberEditor.svelte | Кнопка-редактор числового значения | value, onChange, kind | both |
| BooleanEditor.svelte | Кнопка-переключатель boolean | value, onChange, kind | both |
| BooleanEditorPopup.svelte | Popup выбора true/false/undefined | value, withoutUndefined | internal |
| DateEditor.svelte | Кнопка-редактор даты, попап выбора | value, type, onChange, kind | both |
| EnumEditor.svelte | Кнопка-редактор значения EnumOf | value, type, onChange, allowDeselect | both |
| EnumArrayEditor.svelte | Множественный выбор значений enum | value, type, onChange | view.component.EnumArrayEditor |
| MarkupEditor.svelte | Rich-text редактор markup | value, onChange, kitOptions | both |
| MarkupEditorPopup.svelte | Popup-версия markup-редактора | value, kitOptions, maxHeight | view.component.MarkupEditorPopup |
| HTMLEditor.svelte | Редактор сырого HTML-значения атрибута | object, key | view.component.HTMLEditor |
| CollaborativeDocEditor.svelte | Редактор коллаборативного markup-документа | object, key, onChange | view.component.CollaborativeDocEditor |
| CollaborativeHTMLEditor.svelte | Редактор коллаборативного HTML-документа | object, key | view.component.CollaborativeHTMLEditor |
| ArrayEditor.svelte | Множественный выбор ссылок на документы | object, value, type, onChange | both |
| ArrayEditorPopup.svelte | Popup выбора набора документов | _class, selectedObjects, isSingleSelect | internal |
| HyperlinkEditor.svelte | Редактор строки-ссылки, попап ввода | value, onChange, icon | both |
| HyperlinkEditorPopup.svelte | Popup ввода значения ссылки | value, editable | view.component.HyperlinkEditorPopup |
| PersonArrayEditor.svelte | Множественный выбор персон | value, onChange, kind | view.component.PersonArrayEditor |
| SpaceTypeSelector.svelte | Выбор типа пространства из дескрипторов | descriptors, type, kind | both |

## Объекты и ссылки

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| ObjectBox.svelte | Кнопка выбора документа с dropdown-поиском | _class, value, docQuery, create | import |
| ObjectBoxPopup.svelte | Popup выбора документа(ов) для ObjectBox | _class, selected, selectedObjects, multiSelect | import |
| ObjectPresenter.svelte | Универсальный презентер документа | objectId, value, inline, shrink | both |
| ObjectSearchBox.svelte | Кнопка поиска документа с фильтром по категориям | _class, allowCategory, value | import |
| ObjectMention.svelte | Инлайн-упоминание документа с попапом при клике | _id, _class, object, component | both |
| ObjectIcon.svelte | Иконка документа по mixin или классу | value, size, icon | import |
| DocNavLink.svelte | Обёртка-ссылка на документ, открывает компонент | object, component, inline, props | import |
| DocReferencePresenter.svelte | Презентер значения RelatedDocument | value, compact | import |
| navigator/NavLink.svelte | Ссылка навигации app/space/special | app, space, special, restoreLastLocation | import |
| PersonIdPresenter.svelte | Презентер PersonId, аватар и имя | value, shouldShowName, shouldShowAvatar | both |
| BaseDocPresenter.svelte | Базовый компактный презентер Doc | object, value, size | both |

## Таблицы и списки

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| Table.svelte | Главная таблица: группировка, чекбоксы, шапка | _class, query, config, enableChecking, viewOptions | import |
| TableBrowser.svelte | Обёртка над Table, сама грузит viewlet | _class, query, config, viewlet | both |
| DocTable.svelte | Нереактивная таблица по готовому массиву | objects, config, _class, onContextMenu | internal |
| RelationshipTable.svelte | Таблица связанных документов по Association | _class, query, config, viewOptions | internal |
| RelationshipTableBrowser.svelte | Обёртка над RelationshipTable, грузит viewlet | _class, query, viewlet | view.component.RelationshipTableBrowser |
| list/List.svelte | Список документов с категориями/группировкой | _class, query, viewOptions, config | import |
| list/ListView.svelte | Обёртка над List, слушает клавиатуру | _class, viewlet, config, viewOptions | both |
| list/ListPresenter.svelte | Презентер значения одного атрибута в строке | docObject, attributeModel, value, onChange | import |
| list/ListCategories.svelte | Рекурсивный рендер категорий списка | docs, categoryRefsMap, viewOptions | internal |
| list/ListCategory.svelte | Одна категория списка, рекурсия по вложенным | category, itemProj, itemModels | internal |
| list/ListHeader.svelte | Заголовок группы списка | category, items, collapsed | internal |
| list/ListItem.svelte | Одна строка списка, чекбокс и презентеры | docObject, model, checked, selected | internal |
| list/SortableDocList.svelte | Drag&drop список, сам грузит live query | _class, query, direction | both |
| list/SortableDocListStatic.svelte | Drag&drop список по готовому массиву | _class, items, sortingOrder | both |
| list/SortableList.svelte | Универсальный drag&drop список произвольных items | items, direction, flipDuration | both |
| list/SortableListItem.svelte | Одна draggable-строка для SortableList | isDraggable, isEditable, isDeletable | both |
| list/GrowPresenter.svelte | Растягивающийся презентер-заглушка колонки | - | both |
| list/DividerPresenter.svelte | Презентер-разделитель колонки таблицы | - | both |
| TreeView.svelte | Дерево документов по parent/title | _class, query, titleKey, parentKey | view.component.TreeView |
| FixedColumn.svelte | Обёртка колонки таблицы фиксированной ширины | key, justify, addClass | import |

## Панели и навигация

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| EditDoc.svelte | Главная side-panel редактирования документа | _id, _class, embedded, readonly | both |
| AttachedDocPanel.svelte | Панель редактирования AttachedDoc | _id, _class, embedded | view.component.AttachedDocPanel |
| ParentsNavigator.svelte | Хлебные крошки родителей документа | element, maxWidth | import |
| UpDownNavigator.svelte | Кнопки перехода к соседнему документу | element | both |
| SpaceHeader.svelte | Заголовок страницы пространства | space, _class, viewlet, viewlets | import |
| DocsNavigator.svelte | Список ссылок на документы | elements, maxWidth | both |
| ClassAttributeBar.svelte | Панель кастомных атрибутов класса объекта | object, _class, to, ignoreKeys | import |
| DocAttributeBar.svelte | Панель атрибутов документа по всем миксинам | object, mixins, ignoreKeys | import |
| navigator/TreeElement.svelte | Базовый элемент дерева навигации | _id, icon, label, actions | import |
| navigator/TreeItem.svelte | Лист дерева навигации | _id, icon, label, actions | import |
| navigator/TreeNode.svelte | Узел-секция дерева навигации, группа | _id, title, actions, collapsed | import |
| folders/FoldersBrowser.svelte | Браузер иерархии папок по parent/title | _class, query, titleKey, parentKey | both |
| folders/FolderTreeLevel.svelte | Один уровень рекурсивного дерева папок | folders, folderById, descendants, level | internal |
| masterDetail/MasterDetailBrowser.svelte | Layout master-detail: список и деталь | masterComponent, detailComponent, query | view.component.MasterDetailBrowser |
| masterDetail/MasterDetailView.svelte | Обёртка master-detail, грузит viewlet и список | space, query, viewlet | view.component.MasterDetailView |
| masterDetail/ClassHeader.svelte | Заголовок панели класса для master-detail | _class | internal |
| SidebarPreviewWidget.svelte | Виджет предпросмотра в сайдбаре по Widget/WidgetTab | widget, tab | view.component.SidebarPreviewWidget |

## Вьюлеты и настройки

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| ViewletContentView.svelte | Переключает List/Table по типу вьюлета | viewlet, _class, query, viewOptions | both |
| ViewletPanelHeader.svelte | Заголовок панели: селектор вьюлета и настройки | viewletQuery, viewlet, viewOptions | both |
| ViewletSelector.svelte | Выпадающий селектор вьюлета | viewlet, viewlets, viewletQuery | import |
| ViewletSetting.svelte | Настройка списка колонок: видимость и порядок | viewlet, defaultConfig | internal |
| ViewletSettingButton.svelte | Кнопка настроек вьюлета | viewlet, viewOptions, viewOptionsConfig | both |
| ViewletsSettingButton.svelte | Кнопка настроек с выбором вида и опциями | viewletQuery, viewlet, viewlets | import |
| ViewletClassSettings.svelte | Настройка вьюлета в разрезе классов/атрибутов | viewlet, items | import |
| ViewOptions.svelte | Панель опций группировки/сортировки вьюлета | viewlet, config, viewOptions | import |
| ViewOptionsButton.svelte | Кнопка, открывающая попап ViewOptions | viewlet, viewOptions, viewOptionsConfig | internal |
| ClassSettingButton.svelte | Кнопка настроек кастомных атрибутов класса | _class | both |

## Действия и меню

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| ActionButton.svelte | Кнопка запуска платформенного action по id | id, object, mode, disabled | import |
| ActionHandler.svelte | Слушает горячие клавиши actions пространства | currentSpace | import |
| ActionsPopup.svelte | Command-palette: поиск и запуск actions | viewContext | view.component.ActionsPopup |
| Menu.svelte | Контекстное меню действий над документом(ами) | object, actions, excludedActions, overrides | import |
| ValueSelector.svelte | Popup выбора значения атрибута, мультиселект | value, _class, query, attribute | both |
| Move.svelte | Popup перемещения документа в другое пространство/класс | selected | import |
| SearchSelector.svelte | Кнопка статус-бара, открывает ActionsPopup | - | import |

## Фильтры (filter/)

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| filter/FilterBar.svelte | Панель активных фильтров вьюлета | _class, space, query, viewOptions | import |
| filter/FilterButton.svelte | Кнопка "Filter", открывает FilterTypePopup | _class, space, viewOptions, adaptive | import |
| filter/FilterTypePopup.svelte | Popup выбора атрибута фильтра | _class, target, filter, index | view.component.FilterTypePopup |
| filter/FilterSection.svelte | Один активный фильтр в FilterBar | filter, space | internal |
| filter/FilterSave.svelte | Сохранить фильтры как отдельный вид | viewOptions, _class | internal |
| filter/ModeSelector.svelte | Селектор режима фильтра | filter | internal |
| filter/ArrayFilter.svelte | Фильтр по значению ArrOf-атрибута | _class, filter, onChange | view.component.ArrayFilter |
| filter/ObjectFilter.svelte | Фильтр по ссылке на документ | filter, space, onChange | view.component.ObjectFilter |
| filter/ValueFilter.svelte | Фильтр по списку значений bool/number/enum | _class, filter, onChange, viewOptions | view.component.ValueFilter |
| filter/StringFilter.svelte | Фильтр по строковому атрибуту | filter, onChange | view.component.StringFilter |
| filter/StringFilterPresenter.svelte | Презентер выбранных строковых значений | value | view.component.StringFilterPresenter |
| filter/DateFilter.svelte | Фильтр по дате: сегодня/неделя/диапазон | filter, onChange | view.component.DateFilter |
| filter/DateFilterPresenter.svelte | Презентер выбранного значения date-фильтра | filter, value | view.component.DateFilterPresenter |
| filter/DatePresenter.svelte | Презентер одной даты для DateFilterPresenter | value | internal |
| filter/TimestampFilter.svelte | Фильтр по timestamp-атрибуту | filter, onChange | view.component.TimestampFilter |
| filter/PersonIdFilter.svelte | Фильтр по PersonId-атрибуту | filter, space, onChange | both |
| filter/PersonIdFilterValuePresenter.svelte | Презентер выбранных персон в фильтре | value | both |
| filter/FilterRemovedNotification.svelte | Уведомление об удалении фильтра | onRemove, notification | import |

## Связи (relation/)

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| relation/AddRelationPopup.svelte | Popup добавления связи к документу(ам) | value | both |
| RelationEditor.svelte | Редактор одной связи, направление A/B | object, docs, association, direction | internal |
| RelationsEditor.svelte | Редактор всех связей документа по классу | object, readonly, emptyKind | import |
| RelationsSelectorPopup.svelte | Popup выбора документа для установки связи | association, target | internal |

## Прочее

| Компонент | Purpose | Key props | Доступ |
|---|---|---|---|
| IconPicker.svelte | Popup выбора иконки/эмодзи с цветом | icon, icons, color, showEmoji | import |
| ColorsPopup.svelte | Popup выбора цвета из платформенной палитры | colors, columns, selected | import |
| MetricsInfo.svelte | Дерево метрик производительности | metrics, level, sortOrder | import |
| MetricsParams.svelte | Параметры одной операции в дереве метрик | params, opLog | internal |
| PopupDialog.svelte | Простой popup-контейнер с заголовком | label, embedded | internal |
| ReadOnlyNotification.svelte | Уведомление о read-only режиме воркспейса | onRemove, notification | both |
| ForbiddenNotification.svelte | Уведомление о запрете действия, нет прав | onRemove, notification | both |
| SimpleNotification.svelte | Базовое текстовое уведомление | notification, onRemove | import |
| LinkPresenter.svelte | Презентер внешней ссылки, превью по href | link | import |
| linkPresenters/GithubPresenter.svelte | Презентер-превью ссылки на GitHub | href | view.component.GithubPresenter |
| linkPresenters/YoutubePresenter.svelte | Презентер-превью embed ссылки на YouTube | href | view.component.YoutubePresenter |
| icons/ChevronDown.svelte, ChevronUp.svelte, Close.svelte, Pause.svelte, Play.svelte, UpDown.svelte | Мелкие SVG-иконки: стрелки, крестик, play/pause | size | internal (все 6) |
| viewer/AudioPlayer.svelte | Плеер аудио-blob с элементами управления | value, name, contentType | import |
| viewer/AudioViewer.svelte | Просмотрщик аудио-вложения | value, name, contentType | view.component.AudioViewer |
| viewer/ImageViewer.svelte | Просмотрщик изображения, zoom/fit, drawings | value, name, metadata, fit | view.component.ImageViewer |
| viewer/PDFViewer.svelte | Просмотрщик PDF-вложения | value, name, fit | view.component.PDFViewer |
| viewer/TextViewer.svelte | Просмотрщик текстового вложения | value, name, fit | view.component.TextViewer |
| viewer/VideoViewer.svelte | Просмотрщик видео-вложения | value, name, contentType, metadata | view.component.VideoViewer |
