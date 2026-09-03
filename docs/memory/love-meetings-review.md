# Love / Meetings - результаты review (2026-08-21)

Описание работы подсистемы: `docs/love.md`.

## Что оказалось неочевидным

- `ParticipantInfo` лежит в `DOMAIN_TRANSIENT`, а тот замаплен на адаптер
  `InMemory` (`server/server-pipeline/src/pipeline.ts:386`). Рестарт
  workspace-сессии транзактора стирает всё присутствие, и polling его не
  восстанавливает - `reconcileParticipants` считает участника "не новым",
  раз он есть и в предыдущем, и в текущем снимке LiveKit.
- Координаты участника приходят из metadata LiveKit-токена. `/getToken`
  подставляет сентинел `-1` при отсутствии `x/y` в body
  (`services/love/src/main.ts:329`), а `getFreeRoomPlace` в ветке `pref`
  не валидирует границы комнаты - участник встаёт в `(-1,-1)` и не рендерится.
  Клиент шлёт `x/y` только после клика по конкретной ячейке этажа
  (`selectedRoomPlace`), то есть при входе по инвайту/ссылке - никогда.
- `MeetingStatus.Scheduled = 7` не входит в `notMatch` при создании митинга
  (`meetings.ts:320`), поэтому в комнате с запланированным митингом легко
  появляется второй, параллельный.
- `finishMeeting` re-arm'ит в `Scheduled` только если `meetingScheduledDate`
  ещё в будущем. Для идущего scheduled-митинга пустая комната на 3 секунды
  (`departureTimeout: 3`) = терминальный `Finished` и мёртвая гостевая ссылка.
- `LIVEKIT_OUTAGE_MS = 15s` в `polling.ts` -> `drainAllActiveMeetings()`
  завершает все митинги всех workspace. Порог меньше времени рестарта LiveKit.

## Ловушки при чтении кода

- `RoomPreview.prepareInfo` выглядит как разрешение коллизий координат, но
  `posMap` никогда не заполняется - ветка мертва, конфликтующие участники
  схлопываются в одну ячейку.
- Побочные эффекты (auto-join, removeDoc, звук) живут внутри `derived`-сторов
  в `invites.ts` и пересчитываются на каждое изменение `infos`.

## Исправлено в P0 (2026-08-21)

D1/D17 - `/getToken` больше не подставляет `-1`, `getFreeRoomPlace` валидирует
`pref` по сетке и переполняется по `x` (офис 2x1 держал только двоих, третий
уходил в `y=1` и не рендерился). D2 - `posMap.add` в `RoomPreview.prepareInfo`,
overflow-колонки рендерятся без hover. D3 - удаление PI строго по
`{person, meeting, sessionId}`, клиент перестал перезаписывать `sessionId`
браузерным id.

## F1: разделение Meeting / MeetingMinutes

`MeetingMinutes` совмещает идентичность (ссылка), сессию, Space и машину
состояний. Роли «идентичность» и «сессия» конфликтуют: сессия обязана
завершаться, ссылка - переживать завершение. Отсюда re-arm в `finishMeeting`,
статус `Scheduled` и кнопка «reset meeting» в `EditMeetingData.svelte:56` -
три обхода одного дефекта моделирования. Дизайн разделения - `docs/love.md` 13.2;
он снимает D4, D5, D6, D10 конструктивно.

Ловушка календаря: `calendar.class.Schedule` - это booking-page (availability,
duration), **не** рекуррентность. Рекуррентность - `ReccuringEvent.rules` +
`ReccuringInstance.recurringEventId`; виртуальные инстансы не персистятся,
поэтому привязка серии к митингу возможна только по строковому `eventId`
мастера, не по `Ref<Event>`.

Решения по F1: идентичность митинга - **миксин на мастер-`Event`**
(расширяется существующий `love.mixin.MeetingEventLink`), отдельной сущности
нет; всё живёт в календаре. Ключ, который делает схему рабочей:
`server-plugins/calendar-resources/src/index.ts` уже содержит `onEventCreate`
(:355 - копия события в primary-календарь каждого участника, `access: Reader`,
общий `eventId`), `onEventUpdate` (:202 - разгон правок и чистка копий) и
**`onEventMixin` (:178 - зеркалирование миксина с мастера на все копии)**.
Значит миксин ставится только на мастер, а копии участников становятся
митингами сами. Все три триггера выходят рано при `access !== 'owner'` -
мастер источник правды, копии производные, писать в копию нельзя.

Существующий цикл в love `createMeeting`, навешивающий миксин на все
`Event { eventId }` вручную, из-за `onEventMixin` избыточен.

**F0 - календарь не изолирует события на уровне доступа.** Цепочка:
`TEvent.space!: Ref<SystemSpace>` (`models/calendar/src/index.ts:102`); все
создатели пишут в `calendar.space.Calendar`; тот заводится
`createDefaultSpace` (`models/calendar/src/migration.ts:662`) с дефолтным
классом `core.class.SystemSpace`, `private: false`; `getAllAllowedSpaces`
(`spaceSecurity.ts:724`) кладёт все системные space в разрешённые - для
обычного `findAll` флаг `includeSystem` истинен безусловно; `hidePrivateEvents`
(`plugins/calendar-resources/src/utils.ts:42`) - чистый клиентский фильтр.
Итог: события всех пользователей читаются на уровне БД любым аккаунтом,
разделение по календарям - презентационное.

Решено чинить схему, а не обходить: детали событий переезжают в
`PersonSpace` владельца (`contact.class.PersonSpace` уже есть и уже
используется love для инвайтов), а в системном space остаётся обеднённый
`BusySlot { person, eventId, date, dueDate, rules }` - только занятость, без
названия и состава. Рекуррентность в слоте хранится правилами, не
материализуется. Это единственное, что ломал бы переезд (планирование по
чужой занятости), и оно закрыто. Описано в docs/love.md 13.2 как F0,
предусловие F1.

`getInstance` (`plugins/calendar/src/utils.ts:12`) выдаёт виртуальному
инстансу **новый** `eventId` и копию данных миксина - мастера для инстанса
резолвить через `recurringEventId`.

Прочее: комнату не занимает, привязка к этажу, `RoomType.Scheduled = 3` -
Scheduled Room (одна на этаж, автосоздание триггером, списком запланированные
и отдельно активные). Сессия получает `roomId` = Scheduled Room - это обходит
две мины (`webhook.ts handleJoinLeave` выходит рано при
`roomId === undefined`, `upsertParticipantFromLiveKit` без `Room` сажает всех
в (0,0)). Этаж с комнатами удалять нельзя. Ссылка - указатель поверх
`shortLink`, payload `{eventId, workspace, linkVersion}`, отзыв через
`linkVersion`. Start у всех участников. Записи 30 дней. RSVP в календаре нет
вообще - класть `rsvp` на копию участника.
