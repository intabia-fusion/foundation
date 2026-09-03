# packages/presentation - каталог компонентов и API

Индекс публичного API пакета `@hcengineering/presentation` (`packages/presentation/src/index.ts`). Компоненты вне `index.ts` (`SpaceInfo.svelte`, `icons/*`, `markup/*` и т.п.) не включены - используются только внутри пакета.

## Данные и клиент

| Экспорт | Назначение | Сигнатура / ключевые поля |
|---|---|---|
| `getClient` | Текущий `TxOperations & Client` платформы | `getClient(): TxOperations & Client` |
| `createQuery` | Фабрика live-запроса с авто-обновлением | `createQuery(dontDestroy?: boolean): LiveQuery` |
| `LiveQuery` | Класс живого запроса с подпиской на результат | `query<T>(_class, query, callback, options?)`, `unsubscribe()` |
| `setClient` / `refreshClient` / `closeClient` / `purgeClient` | Жизненный цикл клиента: установка, реконнект, очистка | `setClient(_client): Promise<void>` |
| `onClient` | Подписка на готовность клиента | `onClient(l: OnClientListener): void` |
| `addTxListener` / `removeTxListener` | Подписка на входящие транзакции мимо LiveQuery | `addTxListener(l: TxListener): void` |
| `addRefreshListener` | Колбэк на полный refresh данных | `addRefreshListener(r: RefreshListener): void` |
| `pendingCreatedDocs` | Стор доков, не подтверждённых сервером (optimistic UI) | `writable<Record<Ref<Doc>, boolean>>` |
| `reduceCalls` | Дедуп параллельных вызовов async-функции (re-export core) | `reduceCalls(fn)` |
| `getRawLiveQuery` | Доступ к низкоуровневому `LQ` инстансу | `getRawLiveQuery(): LQ` |
| `PresentationPipeline` / `PresentationPipelineImpl` | Цепочка middleware поверх `Client` | `class PresentationPipelineImpl implements PresentationPipeline` |
| `PresentationMiddleware` / `PresentationMiddlewareCreator` | Контракт клиентских middleware | `type PresentationMiddlewareCreator = (client, next?) => PresentationMiddleware` |
| `OptimizeQueryMiddleware` | Встроенный middleware оптимизации запросов | `class OptimizeQueryMiddleware extends BasePresentationMiddleware` |
| `DraftController` / `MultipleDraftController` | Черновики форм в localStorage со стором подписки | `class DraftController<T>`, `class MultipleDraftController` |
| `draftsStore` / `activeDraftsStore` | Стор черновиков и ключей активных черновиков | `writable<Record<string, any>>`, `writable<Set<string>>` |
| `configurationStore` / `pluginConfigurationStore` | Конфигурация плагинов/фичей воркспейса | `writable<Map<Ref<Configuration>, Configuration>>` |
| `isDisabled` | Отключена ли фича конфигурацией воркспейса | `isDisabled(feature?: string): boolean` |
| `isAdminUser` / `isBillingAdminUser` | Проверка ролей пользователя из токена | `(): boolean` |
| `decodeTokenPayload` | Разбор payload JWT-токена сессии | `decodeTokenPayload(token: string): any` |

## Просмотр и рендер контента

| Компонент/функция | Назначение | Ключевые props / сигнатура |
|---|---|---|
| `MessageViewer` | Рендер markup-сообщения в HTML с подсветкой/эмодзи | `message: string`, `preview = false` |
| `LiteMessageViewer` | Упрощённый рендер Markup без тяжёлых нод | `message: Markup \| MarkupNode`, `colorInherit = false` |
| `HTMLViewer` | Рендер произвольного HTML-значения | `value: string`, `preview = false` |
| `ObjectNode` | Инлайн-ссылка на документ в markup-дереве (mention) | `_id`, `_class`, `title`, `transparent` |
| `FilePreview` | Универсальный превью файла по content-type | `file`, `name`, `contentType`, `fit` |
| `FilePreviewPopup` | Полноэкранный попап-просмотрщик поверх FilePreview | `file`, `name`, `fullSize`, `showIcon` |
| `PDFViewer` | Просмотр PDF инлайн или в полноэкранном режиме | `file: Ref<Blob>`, `name`, `fullSize` |
| `Image` | Оптимизированное изображение с blurhash/lazy-loading | `blob: Ref<Blob>`, `width`, `height`, `fit` |
| `getBlobURL` | Временный object URL для Blob | `getBlobURL(blob: Blob): Promise<string>` |
| `getBlobRef` / `getSrcSet` / `getBlobSrcSet` / `getFileSrcSet` | Построение srcset/URL превьюшек blob-файлов | - |
| `getPreviewThumbnail` / `getPreviewMetadata` | URL миниатюры и метаданные превью (video/HLS) | `getPreviewThumbnail(file, width, height, dpr?)` |
| `canPreviewFile` / `getPreviewType` / `getPreviewAlignment` | Можно ли и как показать превью по content-type | `canPreviewFile(contentType, previewTypes): Promise<boolean>` |
| `fetchLinkPreviewDetails` / `canDisplayLinkPreview` / `isLinkPreviewEnabled` | Получение и проверка превью внешней ссылки | `fetchLinkPreviewDetails(url, ...): Promise<LinkPreviewDetails>` |

## Выбор объектов и пространств

| Компонент | Назначение | Ключевые props |
|---|---|---|
| `ObjectPopup` | Попап выбора документов класса с поиском и созданием | `_class`, `selected`, `multiSelect`, `create` |
| `DocPopup` | Тот же попап по готовому массиву объектов | `_class`, `objects`, `selected`, `multiSelect` |
| `ObjectSearchPopup` | Полнотекстовый поиск/mention объектов по категориям | `query`, `label`, `relatedDocuments`, `allowCategory` |
| `SpaceSelector` | Выпадающий выбор одного Space заданного класса | `space`, `_class`, `query`, `create` |
| `SpaceSelect` | Поле выбора пространства как контролируемый инпут | `_class`, `value`, `spaceQuery`, `autoSelect` |
| `SpaceMultiBoxList` | Кнопка+попап множественного выбора пространств | `selectedItems`, `_classes`, `kind`, `size` |
| `SpacesMultiPopup` | Попап множественного выбора пространств из классов | `_classes`, `selected`, `selectedSpaces` |
| `SpaceCreateCard` | Карточка-обёртка для форм создания пространства | `label`, `okAction`, `okLabel`, `canSave` |

## Карточки и диалоги

| Компонент | Назначение | Ключевые props |
|---|---|---|
| `Card` | Базовый каркас диалога/попапа: шапка, футер, слоты | `label`, `okAction`, `canSave`, `fullSize` |
| `MessageBox` | Диалог подтверждения с опциональным кастомным компонентом | `label`, `message`, `component`, `dangerous` |
| `ActionContext` | Провайдер контекста текущего вида для дочерних экшенов | `context: ViewContext` |

## Атрибуты

| Компонент/функция | Назначение | Ключевые props / сигнатура |
|---|---|---|
| `AttributeEditor` | Редактор одного атрибута с авто-подбором editor-компонента | `_class`, `key`, `object`, `editKind` |
| `AttributeBarEditor` | То же в виде строки боковой панели атрибутов | `key`, `object`, `_class`, `kind` |
| `AttributesBar` | Список редакторов всех атрибутов объекта в панели | `object`, `_class`, `keys`, `readonly` |
| `InlineAttributeBar` | Инлайн-версия панели атрибутов без карточки | `object`, `_class`, `ignoreKeys`, `extraKeys` |
| `InlineAttributeBarEditor` | Инлайн-редактор одного атрибута внутри InlineAttributeBar | `key`, `object`, `_class`, `readonly` |
| `getAttribute` | Чтение значения атрибута с учётом миксинов | `getAttribute(client, object, key: KeyedAttribute): any` |
| `getAttributePresenterClass` | Определение presenter/editor-класса типа атрибута | `getAttributePresenterClass(...)` |
| `getAttrEditor` / `getAttributeEditor` / `findAttributeEditor` / `findAttributeEditorByAttribute` | Поиск компонента-редактора по типу/атрибуту через Hierarchy | - |
| `isCollectionAttr` / `isMarkupAttr` / `isCollabAttr` | Проверка вида атрибута (коллекция/markup/collab) | `(hierarchy, key: KeyedAttribute): boolean` |
| `getFiltredKeys` | Фильтрация ключей класса под набор атрибутов | `getFiltredKeys(...)` |
| `getDocRules` / `isCreateAllowed` | Применение бизнес-правил DocRules к документу | `getDocRules<T>(documents, field): RuleApplyResult<T> \| undefined` |

## Файлы и вложения

| Компонент/функция | Назначение | Ключевые props / сигнатура |
|---|---|---|
| `DownloadFileButton` | Кнопка скачивания файла-blob по ссылке | `file: Ref<Blob>`, `name`, `tooltip` |
| `FileTypeIcon` | Иконка типа файла по имени/расширению | `name: string` |
| `IconDownload` / `IconForward` | Иконки платформы (скачать / переслать) | `size` |
| `getFileUrl` | URL файла в blob-хранилище для `<img src>`/ссылок | `getFileUrl(file: string, filename?): string` |
| `uploadFile` / `deleteFile` | Загрузка/удаление файла в blob-хранилище воркспейса | `uploadFile(file, uuid?, opts?): Promise<...>` |
| `getFileStorage` / `createFileStorage` | Доступ к абстракции файлового хранилища | `getFileStorage(): FileStorage` |
| `getContentType` | Определение MIME-типа по имени и заявленному типу | `getContentType(name, type): string` |
| `generateFileId` / `getCurrentWorkspaceUuid` | Генерация id файла и workspace uuid | `(): string` |
| `getFileMetadata` | Метаданные файла перед загрузкой | `getFileMetadata(file, uuid): Promise<BlobMetadata \| undefined>` |
| `getImageSize` / `imageSizeToRatio` | Размеры изображения и расчёт пропорции с pixelRatio | `getImageSize(file: Blob): Promise<{width, height, pixelRatio}>` |
| `getMarkup` / `createMarkup` / `updateMarkup` / `copyMarkup` | CRUD совместного markup-документа | `getMarkup(doc: CollaborativeDoc, source): Promise<Markup>` |
| `getMarkupVersions` / `getMarkupVersionContent` | История версий совместного документа | `getMarkupVersions(doc): Promise<DocumentVersion[]>` |

## Рисование

| Компонент/функция | Назначение | Ключевые props / сигнатура |
|---|---|---|
| `DrawingBoard` | Холст для рисования поверх изображения (аннотации) | `active`, `readonly`, `drawings: DrawingData[]`, `createDrawing` |
| `DrawingBoardToolbar` | Панель инструментов рисования (кисть/ластик/цвет/undo) | `tool`, `penColor`, `penWidth`, `colorsList` |
| `DrawingData` / `DrawingProps` / `DrawingTool` | Типы данных рисунка и набор инструментов | - |
| `ThemeAwareColor` / `DrawingBoardColoringSetup` / `ColorsList` | Палитра цветов доски, адаптивная к теме | `class ThemeAwareColor`, `class DrawingBoardColoringSetup` |
| `metaColorNameToHex` | Именованный цвет палитры в hex с учётом темы | `metaColorNameToHex(...)` |
| geometry-хелперы (`makeNodePoint`, `scalePoint`, `offsetPoint`, `middlePoint`, `rescaleToFitAspectRatio`, ...) | Утилиты координат/точек на холсте рисования | - |

## Прочее / расширения

| Компонент/функция | Назначение | Ключевые props / сигнатура |
|---|---|---|
| `NavLink` | Ссылка-навигация с обработкой клика/alt-клика | `href`, `title`, `onClick`, `onAltClick` |
| `SearchResult` | Отображение результата глобального поиска | `value: SearchResultDoc` |
| `IconWithEmoji` | Иконка объекта: эмодзи, коды или файл | `icon: number \| number[] \| Ref<Blob>`, `size` |
| `Breadcrumbs` | Строка хлебных крошек по модели BreadcrumbsModel[] | `models`, `disabled`, `maxWidth` |
| `BreadcrumbsElement` | Один элемент крошки (позиция, выделение) | `label`, `position`, `selected`, `color` |
| `ComponentExtensions` | Рендер зарегистрированных компонентов по extension | `extension: ComponentExtensionId`, `props` |
| `DocCreateExtComponent` | Точка расширения форм создания документа | `manager`, `kind: CreateExtensionKind`, `space` |
| `DocCreateExtensionManager` | Менеджер регистрации расширений форм создания | `class DocCreateExtensionManager` |
| `searchFor` | Полнотекстовый поиск с группировкой по категориям | `searchFor(...): Promise<SearchItem[]>` |
| `copyTextToClipboard` / `copyTextToClipboardOldBrowser` | Копирование текста в буфер с фолбэком для старых браузеров | `copyTextToClipboard(text): Promise<void>` |
| `remToPx` / `sizeToWidth` | Пересчёт rem->px и размера-строки в px | `remToPx(rem: number): number` |
| `getCurrentWorkspaceUrl` | URL текущего воркспейса для ссылок | `getCurrentWorkspaceUrl(): string` |
| `isSpace` / `isSpaceClass` | Type guard и проверка класса-наследника Space | `isSpace(space: Doc): space is Space` |
| `setPresentationCookie` | Cookie авторизации для сервисов вне клиента | `setPresentationCookie(token, workspaceUuid): void` |
| `upgradeDownloadProgress` / `setDownloadProgress` | Стор и сеттер прогресса скачивания апдейта | `writable<number>`, `setDownloadProgress(percent): void` |
| `loadServerConfig` | Загрузка серверного конфига по URL | `loadServerConfig(url): Promise<any>` |
| `isNotificationAllowed` / `playSound` / `playThrottledSound` / `playNotificationSound` / `prepareSound` | Звуковые уведомления: разрешение и проигрывание | - |
| `MemoryStatistics` / `CPUStatistics` / `WorkspaceStatistics` / `OverviewStatistics` и др. | Типы серверной статистики для админ-панелей | - |
