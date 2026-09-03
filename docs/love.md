# Love - виртуальный офис и митинги

Как подсистема устроена и работает сейчас. Заменяет
`security_meeting_minutes.md`, `livekit_meeting_minutes.md`, `love-tests.md`,
`sanity-meetings-tests.md` и `services/love/src/__tests__/README.md`.

Актуально на 2026-08-21, ветка `develop`. Описывает текущее поведение;
планов работ здесь нет.

## Содержание

1. [Карта кода](#1-карта-кода)
2. [Модель данных](#2-модель-данных)
3. [Безопасность](#3-безопасность)
4. [Жизненный цикл митинга](#4-жизненный-цикл-митинга)
5. [Подключение](#5-подключение)
6. [Присутствие в комнатах](#6-присутствие-в-комнатах)
7. [Invite / Knock](#7-invite--knock)
8. [Гости](#8-гости)
9. [Запись и транскрипция](#9-запись-и-транскрипция)
10. [Исправленные дефекты](#10-исправленные-дефекты)
11. [Тесты](#11-тесты)
12. [QA-сценарии](#12-qa-сценарии)

---

## 1. Карта кода

| Пакет | Роль |
|---|---|
| `plugins/love` | Типы, `getFreeRoomPlace`, `parseRoomName`, дефолтные комнаты |
| `plugins/love-resources` | Клиент: стора, `meetings.ts`, `invites.ts`, `liveKitClient.ts`, `loveClient.ts`, Svelte-компоненты |
| `models/love` | Модель классов, миграции |
| `server-plugins/love-resources` | Серверные триггеры: `OnUserMeetingInvite`, `OnEventUpdate`, `RoomInfo` |
| `services/love` | HTTP-сервис: `/getToken`, `/webhook`, гости, записи, polling, биллинг |
| `services/ai-bot/love-agent` | Транскрипция |

---

## 2. Модель данных

### 2.1 Room / Office

`plugins/love/src/types.ts`, домен `DOMAIN_LOVE`.

- `Room extends Doc`: `name`, `type` (Video/Audio/Reception), `floor`,
  `width`, `height`, `x`, `y`, `language`, `startWithTranscription`,
  `startWithRecording`, `startPrivate`, `description`.
- `Office extends Room`: `person: Ref<Person> | null`.

Комната - слот на этаже. Митинг в ней - отдельный документ.
Дефолтная раскладка (`createDefaultRooms`): 12 офисов **2x1**, All hands 9x3,
две Meeting Room 4x3, две Voice Room 4x3.

### 2.2 MeetingMinutes

`MeetingMinutes extends Space`, домен `DOMAIN_SPACE`.
От `Space`: `name`, `description`, `private`, `archived`, `members`, `owners`.
Своё: `status`, `roomId`, `descriptionRef`, `summary`, `meetingScheduledDate`,
`meetingEnd`, `transcriptionState`, `recordingState`, `language`,
`startWithRecording`, `startWithTranscription`, счётчики
`transcription`/`messages`/`attachments`/`recordings`.

`MeetingStatus`:

| Значение | Имя | Смысл |
|---|---|---|
| 0 | `Active` | LiveKit-комната существует, идёт митинг |
| 1 | `Finished` | Терминальное. Фильтруется из клиентского стора `meetings` |
| 2 | `Pending` | Документ создан клиентом, LiveKit-комната ещё не стартовала |
| 7 | `Scheduled` | Создан из календарного Event, ждёт начала |

До миграции `meeting-minutes-to-space` жил в `DOMAIN_MEETING_MINUTES` как
`AttachedDoc` c `title`/`attachedTo`. Миграция переносит в `DOMAIN_SPACE`
(`title -> name`, `attachedTo -> roomId`) и чинит `space` у `PendingRecording`,
`ActivityMessage`, `Attachment`. Класс `LegacyMeetingMinutes` оставлен
как якорь домена.

Класс `MeetingInfo` и `RoomAccess` (`Open`/`Knock`/`DND`) удалены. Активные
митинги определяются через `ParticipantInfo`, knock переехал на флаг `room?`
у `UserMeetingInvite`.

### 2.3 ParticipantInfo

Домен `DOMAIN_TRANSIENT`, замаплен на адаптер `InMemory`
(`server/server-pipeline/src/pipeline.ts:386`) - **живёт только в памяти
транзактора**, TTL-миксина нет.

Поля: `person`, `name`, `meeting`, `room`, `x`, `y`, `sessionId`, `account`, `kind`.

**Инварианты:**

- Клиент **никогда** не создаёт, не меняет и не удаляет `ParticipantInfo`.
  Создание - webhook `participant_joined`, удаление - `participant_left`,
  место на сетке считает сервер (`getFreeRoomPlace` в
  `upsertParticipantFromLiveKit`).
- `sessionId` - **LiveKit participant sid**, собственность сервера. Именно по
  нему `upsertParticipantFromLiveKit` находит строку, а
  `removeParticipantFromLiveKit` её удаляет.
- Из этого следует: пока webhook нового подключения не пришёл, `myInfo` на
  клиенте всё ещё описывает **прошлый** митинг. Любое решение по нему
  (например «нас вынесло из комнаты» в `ControlExt.svelte:120`) обязано
  сверять `sessionId` с текущим `localParticipant.sid`.

### 2.4 UserMeetingInvite

Домен `DOMAIN_TRANSIENT` + миксин `TransientTTL { ttl: 30 }`
(`models/love/src/index.ts:630`).

| Поле | Тип | Назначение |
|---|---|---|
| `kind` | `'invite-request' \| 'invite-response'` | request - в `PersonSpace(from)`; response - в `PersonSpace(to)`, создаётся триггером |
| `from` | `Ref<Person>` | Отправитель |
| `to` | `Ref<Person>` | Получатель. Для knock заполняется триггером (owner митинга) |
| `meeting?` | `Ref<MeetingMinutes>` | Митинг уже существует (A1, Б после accept) |
| `room?` | `Ref<Room>` | Только knock - комната, в которую стучимся |
| `status` | `'pending' \| 'accepted' \| 'declined'` | Синхронизируется request <-> response триггером |
| `acceptedSessionId?` | `string` | sessionId вкладки, нажавшей accept. Multi-tab guard |

### 2.5 Связь с календарём

- `MeetingEventLink extends Event` (миксин на `calendar.class.Event`): `room`, `meetingId`.
- `MeetingSchedule extends Schedule` (миксин): `room`. **`calendar.class.Schedule`
  - это booking-page** (`availability`, `meetingDuration`, `meetingInterval`),
  а не рекуррентность. Рекуррентность живёт в `ReccuringEvent { rules, exdate,
  rdate }` + `ReccuringInstance { recurringEventId, originalStartTime, virtual }`;
  инстансы разворачиваются на клиенте через `getAllEvents` и не персистятся.
- Создание: `plugins/love-resources/src/utils.ts:384 createMeeting`
  (`DocCreateFunction`, фаза `post`) - один `MeetingMinutes` со `status: Scheduled`
  и `meetingScheduledDate: event.date`, миксин вешается на **все** события серии,
  гостевая ссылка пишется в `event.location`.
- Триггер `OnEventUpdate` (`server-plugins/love-resources/src/index.ts:720`)
  синхронизирует `meetingScheduledDate` и участников при сдвиге Event,
  **только пока митинг в статусе `Scheduled`** (:754).

---

## 3. Безопасность

`MeetingMinutes` - это `Space`, поэтому работает общий `spaceSecurity.ts`.

| Действие | Условие | Результат |
|---|---|---|
| Создать приватный space с `owners: [я]` | - | OK |
| Создать приватный space с `owners: [другой]` | - | `Only owners can create private spaces` |
| Создать приватный space с `owners: []` | - | отказ |
| Создать публичный space | - | OK (намеренно) |
| Сменить `private` | я не в `owners` | `Only owners can change space privacy` |
| Сменить `owners` (set/$push/$pull) | я не в `owners` | `Only owners can change space owners` |
| Сменить `members` приватного space | я не в `owners` | `Only owners can change members of private spaces` |
| `$pull: { members: я }` (self-leave) | я в `members`, не owner | OK |
| `$pull: { members: { $in: [я, X] } }` | я не в `owners` | `Only owners can change members of private spaces` |
| `$push: { members: я }` в `autoJoin` space | я не в `owners` | OK |
| Любые изменения space с `owners.size === 0` | - | OK (legacy) |

Системный аккаунт и `AccountRole.Owner` обходят проверки. Фильтрация `findAll`
выполняется в PostgreSQL-адаптере по аккаунту сессии; `searchFulltext` получает
явный список разрешённых space.

`ensurePerson` атомарен (`ON CONFLICT DO NOTHING` + откат orphan-person);
Mongo как backend AccountDB не поддерживается. `OnEmployeeCreate` сериализует
создание `PersonSpace` через `control.withScope`, поэтому дублей при
параллельной регистрации нет.

`pods/server/src/rpc.ts` маппит `PlatformError` в HTTP-коды
(`BadRequest -> 400`, `Unauthorized -> 401`, `Forbidden -> 403`,
`NotFound -> 404`, прочее -> 500).

---

## 4. Жизненный цикл митинга

```
        client createMeetingDocument            LiveKit room_started
  (нет) --------------------------> Pending -----------------------> Active
                                       |                               |
   calendar createMeeting              |                               | room_finished
  (нет) ----------------------> Scheduled --(тот же путь)--> Active ---+---> Finished
                                                                       |
                                        meetingScheduledDate в будущем |
                                                                       +---> Scheduled (re-arm)
```

- `activateMeeting` (`services/love/src/workspaceClient.ts:201`) отказывается
  поднимать `Finished` обратно.
- `finishMeeting` (:221) переводит в `Scheduled` вместо `Finished`, если
  `meetingScheduledDate > Date.now()`; иначе `Finished` + `meetingEnd`.
  Затем чистит все `ParticipantInfo` митинга и pending-инвайты.
- `checkUnfinishedMeetings` завершает `Active`/`Pending` митинги без
  LiveKit-комнаты старше `UNFINISHED_MEETING_GRACE_MS = 60s`.

### 4.1 Создание документа

`plugins/love-resources/src/meetings.ts:320 createMeetingDocument`:
`client.apply()` c `notMatch(MeetingMinutes, { roomId, status: { $in: [Active, Pending] } })`,
затем `createDoc` со `status: Pending`. При провале `notMatch` или исключении -
переиспользует найденный митинг. Ретрай через 250 мс.

---

## 5. Подключение

### 5.1 Точки входа

| Точка входа | Код | Что делает |
|---|---|---|
| Клик по комнате -> Connect/Start | `EditRoom.svelte:49 connect()` | Ищет митинг по `roomId` в сторе, иначе `createMeeting(room)` |
| Панель MeetingMinutes -> Join/Start | `EditMeetingMinutes.svelte:67` | `joinMeeting(object)` |
| `RoomPopup` | `RoomPopup.svelte:68` | `createMeeting(room, meeting)` |
| Клик по аватару в офисе | `PersonActionPopup.svelte:45` | `createMeeting(room)` -> invite |
| Принятый invite / knock | `invites.ts:500..535` | `joinOrCreateMeetingByInvite` |
| Гостевая ссылка | `GuestMeetingApp.svelte` -> `/guestJoin` | Отдельный путь |
| Reconnect после refresh | `meetings.ts:433 reconnectToCurrentMeeting` | По якорю в `sessionStorage` |

### 5.2 `connectToMeeting` (`meetings.ts:242`)

1. Отказ для `AccountRole.ReadOnlyGuest`.
2. Уже в этом митинге - выход; в другом - `leaveMeeting()`.
3. `currentMeeting = mm._id`, резолв `Room`.
4. `navigateToOfficeDoc(mm)`.
5. `loveClient.getRoomToken(mm)` -> POST `/getToken`.
6. `myConnectingSessionId.set(sessionId)`.
7. `liveKitClient.connect(wsURL, token, withVideo)`.
8. `navigateToMeetingMinutes(mm)`, сброс connecting-флага,
   `rememberActiveMeeting(mm._id)` в `sessionStorage`.

`ParticipantInfo` в этом потоке клиент не трогает: строку создаёт сервер по
`participant_joined`. Ранее здесь был `moveToMeetingRoom`, который перецеплял
старую строку на новый митинг - из-за этого удаление по
`{person, meeting, sessionId}` промахивалось и в комнате оставался призрак.

### 5.3 `/getToken` (`services/love/src/main.ts:282`)

1. `decodeMeetingToken` - `meetingId` из body, workspace из платформенного токена.
2. Доступ: `private` митинг и аккаунт не в `members` -> 403. Исключение -
   системный аккаунт и `AccountRole.Owner`.
3. `listRooms([roomName])`, `roomName = ${workspaceUuid}_${meetingId}`.
   Нет комнаты -> `createRoom` с `departureTimeout: 3`, метаданными
   `{projectKey, workspaceId, meetingId}` и agent-dispatch.
4. `createToken`: `identity = person._id`, `metadata = {x, y}`, `ttl: 10m`.

`x`/`y` отправляются только если пользователь кликнул конкретную ячейку этажа
(стор `selectedRoomPlace`); иначе поля отсутствуют и место выбирает сервер.

### 5.4 Reconnect после refresh

`sessionStorage['love.activeMeeting']` - якорь, который ставит
`connectToMeeting` и снимает `leaveMeeting`. Он же даёт multi-tab guard:
у каждой вкладки свой `sessionStorage`. `reconnectToCurrentMeeting`
срабатывает только при наличии якоря, отсутствии активного/идущего коннекта
и статусе митинга `Active`/`Pending`.

### 5.5 Выход и каскад

- `leaveMeeting` (`meetings.ts:108`) - только `liveKitClient.disconnect()`.
- `participant_left` -> `removeParticipantFromLiveKit`.
- Если ушедший - владелец офиса, сервер делает `RoomServiceClient.deleteRoom`,
  LiveKit отключает остальных, каждый получает свой `participant_left`.
- `room_finished` -> `finishMeeting`.

### 5.6 Reconciliation (`services/love/src/polling.ts`)

Каждые `intervalMs`:

- `listRooms` по проекту;
- на комнату: биллинг, `reconcileParticipantsWithDatabase` (удаляет PI,
  которых нет в LiveKit), `reconcileParticipants` (по diff с in-memory
  снимком прошлого цикла досоздаёт/удаляет PI);
- `checkUnfinishedMeetings` для накопленных workspace;
- раз в час `cleanupOrphanedParticipantInfos` / `cleanupOrphanedPendingRecordings`;
- LiveKit недоступен дольше `LIVEKIT_OUTAGE_MS = 15s` -> **один раз**
  `drainAllActiveMeetings()`, завершающий все Active/Pending митинги всех
  известных workspace.

Цикл планируется через `setTimeout` (не `setInterval`): три подряд пустых
прохода (`ourRooms.length === 0`) переводят интервал на `IDLE_INTERVAL_MS = 60s`,
а `wakeUp()` из webhook-хендлера сбрасывает back-off. Флаг `polling` не даёт
`wakeUp` запустить второй цикл поверх идущего. Back-off процесс-локальный:
webhook будит только ту реплику, которая его приняла.

`reconcileParticipantsWithDatabase` удаляет PI не только по отсутствию identity
в LiveKit, но и по мёртвому `sessionId` - строка, чей `participant_left` потерян,
пока человек уже перезашёл под новым sid, иначе остаётся призрачным местом.

---

## 6. Присутствие в комнатах

### 6.1 Поток

1. LiveKit -> `participant_joined` -> `/webhook` -> очередь `LoveQueue`
   (партиции по workspace) -> `WebhookProcessor.handleJoinLeave`.
2. `parseParticipantMetadata(participant.metadata)` -> `{x?, y?}`.
3. `upsertParticipantFromLiveKit` (`workspaceClient.ts:387`):
   ищет PI по `{person, meeting, sessionId}`; дубликаты удаляет; нашёл -
   `update`; не нашёл - `getFreeRoomPlace(...)` и `createDoc`.
4. Клиент: `statusQuery` на `love.class.ParticipantInfo` ->
   `filterParticipantInfo` (дедуп по `person`) -> `RoomPreview` рендерит сетку
   `room.height` x `room.width + extraRow`, в ячейке - первый PI с такими
   координатами.

### 6.2 Правила размещения (`getFreeRoomPlace`, `plugins/love/src/utils.ts:258`)

- Свой офис -> всегда `(0,0)`.
- `pref` принимается только если попадает в сетку комнаты и ячейка свободна.
- Иначе скан `y` в `[0, height)`, `x` в `[0, width)`; ячейка `(0,0)` офиса
  зарезервирована за владельцем.
- Комната заполнена -> overflow по **x** (`x >= width`). Расти по `y` нельзя:
  `RoomPreview` расширяет сетку дополнительными колонками, но не строками.

### 6.3 Что делает `RoomPreview`

- `prepareInfo` разводит участников с совпавшими координатами по свободным
  ячейкам, при переполнении - в overflow-колонки.
- `calcExtraRows` считает число дополнительных колонок; колонки под overflow
  рендерятся всегда, дополнительная пустая колонка для «встать сюда» -
  только под курсором.
- `(0,0)` офиса показывает аватар владельца, пока там нет `ParticipantInfo`.
- разведённые координаты пишутся обратно в БД, иначе каждый браузер рисует
  свою раскладку: писателем выступает **создатель митинга**
  (`meeting.createdBy` против `getCurrentAccount().socialIds`), запись идёт
  через `apply()` + `notMatch` по целевой ячейке, overflow-ячейки не пишутся.
- `busyPersons` - участники, чей митинг отсутствует в нашем сторе `meetings`
  (нет доступа): показываются с бейджем Busy без названия митинга.

---

## 7. Invite / Knock

### 7.1 Heartbeat и TTL

- `TransientTTL = 30s`. Любая CUD-операция по документу сбрасывает TTL на
  сервере (`foundations/server/packages/middleware/src/transient.ts`);
  по истечении middleware шлёт `TxRemoveDoc` + broadcast.
- **Heartbeat 15s** от sender: no-op `TxUpdateDoc invite-request`. Триггер
  проксирует update в invite-response, TTL обоих сбрасывается. Один
  пропущенный тик переживается.
- Закрыли вкладку -> heartbeat встал -> через 30s оба документа умирают.
- TTL - safety net. Основной cleanup делает клиент, наблюдая accept/decline.

### 7.2 Сценарий A1: зовём в существующий митинг

1. **caller** `$push` получателя в `meeting.members` (если owner или митинг
   не private), затем `createDoc invite-request { from, to, meeting, status: 'pending' }`.
2. **Триггер** -> `createDoc invite-response` в `PersonSpace(to)` +
   `CommonInboxNotification(InvitingYou)` (persistent, missed-call индикатор).
3. **recipient** Accept -> `updateDoc invite-response { status: 'accepted', acceptedSessionId }`.
4. **Триггер** -> `removeDoc invite-response` + sync `invite-request`.
5. **caller** видит `accepted` -> `removeDoc invite-request`.
6. **recipient** во вкладке с совпавшим `acceptedSessionId` -> `connectToMeeting`.

### 7.3 Сценарий A2: митинга ещё нет

Шаги 1-4 те же, `meeting: undefined`.

5. **caller** сам `createDoc MeetingMinutes` в своём офисе
   (`members: [caller, recipient]`, `owners: [caller]`), подключается,
   `removeDoc invite-request`.
6. **recipient** ведёт live-query
   `MeetingMinutes { status, roomId: <офис caller>, members: {$all:[me, from]} }`
   и подключается, как только увидит.

**Tie-breaker:** митинг создаёт только caller. Гонки за `createDoc` нет.

### 7.4 Сценарий Б: knock в private митинг

1. **knocker**: `createDoc invite-request { from: me, to: me, room: roomId, status: 'pending' }`.
   Поле `to` здесь - заглушка.
2. **Триггер** (`room !== undefined`): найти
   `MeetingMinutes { roomId, status: {$in:[Active,Pending]}, private: true }` = M;
   на каждого `owner in M.owners` (fallback `M.members`) создать
   `invite-response` + нотификацию.
3. **Любой owner** Accept -> `updateDoc invite-response { status: 'accepted', acceptedSessionId }`.
4. **Триггер**: auth-check `actor in M.owners`; `$push knocker -> M.members`;
   удалить этот и все sibling-response; sync `invite-request { accepted, meeting: M._id }`.
5. **knocker** видит `accepted` + `meeting` -> `connectToMeeting(M)` -> `removeDoc invite-request`.
6. **Decline:** один owner - удаляется только его response; последний -
   sync `invite-request { declined }` -> toast -> `removeDoc`.

### 7.5 Инварианты

- **Cancel (sender)**: `removeDoc invite-request` -> триггер сносит все связанные response.
- **Accept**: триггер удаляет response сразу и синхронизирует request.
- **Только caller создаёт meeting** в A2.
- **`acceptedSessionId`** обязателен для multi-tab guard.
- **Persistent missed-call notification** не удаляется при cancel/expire/decline.
- **Multi-owner knock**: один request -> N response; после accept остальные снимаются.

### 7.6 Триггер `OnUserMeetingInvite`

`server-plugins/love-resources/src/index.ts`. Ветки:

- `TxCreateDoc invite-request` c `room` - knock, fanout по owner-ам;
- `TxCreateDoc invite-request` без `room` - одиночный invite-response;
- `TxRemoveDoc invite-request` - cancel, снести все response;
- `TxUpdateDoc invite-request` - heartbeat-proxy, no-op update по каждому response;
- `TxUpdateDoc invite-response { accepted | declined }` - см. сценарии выше.

Триггер **не** создаёт `MeetingMinutes` и **не** пушит members при обычном
invite - это делает клиент-caller.

### 7.7 Клиентская сторона

`plugins/love-resources/src/invites.ts`:

- universal heartbeat 15s для всех своих pending `invite-request`;
- `outgoingInvitesStore` - `kind === 'invite-request' && from === me`;
- `incomingInvitesStore` - `invite-response && to === me && room === undefined && pending`;
- `knockingInvitesStore` - `invite-response && to === me && room !== undefined && pending`;
- `checkAndJoinIfRecipientJoined` - watcher отправителя;
- `checkAndJoinIfRecipientAccepted` - watcher получателя.

UI: `OutgoingInvitePopup`, `IncomingInvitePopup`, `InviteButton`
(лейблы `YouInvite` / `KnockingTo` / `KnockingLabel`), `KnockingList`
(pending knock-и в виджете владельца), `AwaitingMeetingPopup` (A2, «Waiting for ...»),
кнопка Knock в `EditRoom.svelte`.

---

## 8. Гости

### 8.1 Приложение

- `GuestMeetingApp.svelte` - полноэкранное приложение. Query-параметры
  `meetingId`, `guestToken`; верификация через `/guestInfo`; стилизовано под LoginApp.
- `GuestJoinPopup.svelte` - запрос имени, если не удалось подключиться автоматически.
- `GuestControlBar`, `GuestParticipantView`, `GuestParticipantsListView` -
  упрощённый UI.

### 8.2 Ссылки

При создании Event с комнатой генерируется гостевая ссылка через
`login.function.GetInviteLink` и пишется в `event.location`; содержит
`inviteId` + `navigateUrl` с `meetId`.

### 8.3 Эндпоинты (`services/love/src/guests.ts`)

- `/guestInfo` -> `{meetingId, workspace, workspaceUrl, now, meetingScheduledDate,
  meetingEnd, title, meetingStatus, roomFound}`.
- `/guestJoin` (:158): `Scheduled` -> 403 «Meeting has not started yet»;
  `Finished` -> 403 «Meeting has already finished»; нет LiveKit-комнаты -> 404;
  иначе `ensurePersonByName` (`addGuestEmployee: true`) и выдача токена.

---

## 9. Запись и транскрипция

- `TranscriptionState`: `NotStarted` / `Transcribing` / `Finished`.
  `RecordingState`: `NotStarted` / `Recording` / `Finished`.
- `PendingRecording` (домен `DOMAIN_LOVE_PENDING`, коллекция на `MeetingMinutes`):
  `egressId`, `format` (`video`/`audio`), `startedAt`, `roomName`, `name`,
  `size`, `status` (`active`/`cancelled`/`completed`).
- `/startRecord` создаёт `PendingRecording` **до** вызова egress и дописывает
  `egressId` после - строка служит защитой от второго запуска, общей для всех
  реплик сервиса. Если egress упал, резервация снимается; если за время старта
  запись успели отменить, `setPendingRecordingEgressId` вернёт `cancelled` и
  egress глушится сразу. Webhook `egress_started` только логирует;
  `egress_updated` обновляет размер; `egress_ended` сохраняет файл в storage,
  вешает на митинг и удаляет `PendingRecording`.
- Polling каждый цикл сверяет `listEgress({ active: true })` с `PendingRecording`
  и глушит egress, за которым не стоит ни одной строки: старт мог свалиться по
  таймауту уже после того, как LiveKit его принял. Проверить руками:

  ```js
  new EgressClient(url, key, secret).listEgress({ active: true })
  ```

- `/transcription` сам пишет `transcriptionState` на `MeetingMinutes`
  (`Transcribing` / `Finished`). Кнопки записи и транскрипции читают состояние
  из документов, а не из room metadata: флаг в metadata идёт через очередь и
  протухает, когда та деградирует.
- Если у митинга `startWithRecording`, запись стартует по событию очереди
  `QueueMeetingEvent.started`.
- Presenters: `MeetingMinutesRecordingStatePresenter`,
  `MeetingMinutesTranscriptionStatePresenter`, `PendingRecordingPresenter`.

---

## 10. Исправленные дефекты

Найдены и закрыты 2026-08-21. Все четыре - один симптом: участник не виден в
комнате или участники схлопываются в одну ячейку.

| # | Проблема | Правка |
|---|---|---|
| D1 | `/getToken` подставлял `x = req.body.x ?? -1`. Клиент шлёт координаты только после клика по ячейке этажа, поэтому при входе по invite, knock, ссылке или reconnect участник попадал в `(-1,-1)` и не рендерился | `main.ts` шлёт `undefined` вместо сентинела; `getFreeRoomPlace` принимает `pref` только внутри сетки комнаты |
| D2 | `RoomPreview.prepareInfo` объявлял `posMap`, проверял `has`, но никогда не делал `add` - разрешение коллизий было мёртвым кодом, совпавшие координаты схлопывались в одну ячейку | `posMap.add(...)`; при переполнении конфликтующие уходят в overflow-колонки |
| D3 | `removeParticipantFromLiveKit` удалял все PI по `{person, meeting}`. После refresh новый PI создавался сразу, а `participant_left` старого sid прилетал через `departureTimeout: 3` и стирал свежий. Усугублялось тем, что клиент перезаписывал `sessionId` браузерным id, из-за чего lookup по sid не совпадал и плодил дубли | Удаление строго по `{person, meeting, sessionId}`; клиент больше не пишет `sessionId` |
| D17 | Офис - сетка 2x1. Третий участник получал `(0,1)`, а сетка рендерит только `y in [0,1)`. Overflow-колонки существовали, но `calcExtraRows` возвращал их только под курсором | `getFreeRoomPlace` переполняется по `x`; overflow-колонки рендерятся всегда |

Найдены и закрыты 2026-08-26 (FUSIO-1242).

| # | Проблема | Правка |
|---|---|---|
| D14 | Ветка `pref` в `getFreeRoomPlace` не знала правила «(0,0) офиса принадлежит владельцу»: кликнув по этой ячейке чужого офиса, гость вставал на место владельца и прятал его аватар | `pref` отвергается, если целится в ячейку владельца офиса |
| D18 | Гард от двойного старта записи жил в `Set` внутри процесса, а `/startRecord` стоит за балансировщиком. Проверка и запись были разнесены двумя `await`, так что двойной клик проходил и на одной реплике | Резервация - `PendingRecording`, созданный **до** egress; `egressId` дописывается после |
| D19 | `updateMetadata` мержил флаги поверх процесс-локального кэша room metadata. Webhook мог положить в кэш снимок LiveKit старше последнего `updateRoomMetadata`, и следующий флип стирал чужой флаг (`transcription` терялся при старте записи) | Кэш убран, блоб читается через `listRooms` перед каждым мержем |
| D20 | `transcriptionState` писал только ai-bot. Без развёрнутого бота кнопка транскрипции никогда не переходила в «включено», и остановка была недостижима | `/transcription` пишет состояние сам; ai-bot дублирует идемпотентно |
| D21 | `wakeUp()` мог запустить второй `poll()` поверх идущего - два прохода по одним комнатам | Флаг `polling` в `runCycle` |
| D22 | Строка `ParticipantInfo` с мёртвым `sessionId` (потерянный `participant_left` при перезаходе) оставалась призрачным местом в комнате | Polling сносит PI, чей sid отсутствует среди живых участников LiveKit |
| D23 | Сессия, живущая только в cookie, не подхватывалась на странице логина: `chooseToken` был загейчен на `LastAccount` в localStorage. Форма показывала «Signed in as», а «Select workspace» уводил на форму регистрации | `restoreSession()` зеркалит cookie-сессию в `Token`/`LastAccount`; зовётся из `LoginApp` и `LoginForm`. Не love, но найдено этим же прогоном |
| D24 | Сессия, созданная в muted-состоянии, не несла `deviceId`, и первый unmute захватывал устройство браузера по умолчанию. Отдельно: `getMediaDevices` затирал сохранённый выбор фолбэком, когда устройство временно отключено | `useMedia` проставляет `deviceId` и для muted-сессии; сохранённый id перезаписывается только при реальном совпадении |

Найдены и закрыты 2026-08-28 (FUSIO-1242). D4-D10 - нумерация из
`love-meetings-rework.md` (там же карточки с разбором), D25 - находка этого же
прогона.

| # | Проблема | Правка |
|---|---|---|
| D4 | `EditRoom.connect` брал любой митинг комнаты из неупорядоченного стора, включая `Scheduled` на следующую неделю. Нажавший Connect попадал в чужой запланированный митинг, `room_started` переводил его в `Active`, и к назначенному времени митинг уже «прошёл» | `pickRoomMeeting`: `Active` -> `Pending` -> `Scheduled` только внутри окна запуска (`isScheduledJoinable`) |
| D5 | `createMeetingDocument` считал `Scheduled` живым безусловно, поэтому ad-hoc Connect в комнате с митингом на следующую неделю не создавал новый документ, а «оживлял» запланированный | `notMatch` снова только `Active`/`Pending`; `Scheduled` переиспользуется явной проверкой окна перед `apply()` |
| D7 | Refresh страницы приходит в LiveKit обычным `participant_left`. Если это владелец офиса - `deleteRoom` выкидывал всех: хост нажал F5, митинг закончился у всех | Webhook только ставит `ownerLeftAt` в metadata комнаты LiveKit. Закрывает polling: штамп старше `OWNER_REJOIN_GRACE_SEC` (15 с) и владельца нет среди участников - `deleteRoom`; вернулся - штамп снимается. Сервис реплицируется, поэтому отложенный таймер в памяти процесса не годится: общие часы лежат в LiveKit |
| D10 | `/getToken` проверял `private` и членство, но не `status`. Для `Finished` выдавался токен, LiveKit-комната пересоздавалась, а клиент оказывался подключён к комнате, которой нет в сторе `meetings` | 409 на `Finished`; `joinOrCreateMeetingByInvite` не ретраит 409 |
| D25 | D18 закрыли только видео-путь. `startAudioRecording` (его зовёт `/transcription`) не проверял существующие записи и создавал `PendingRecording` **после** egress - два вызова давали два аудио-egress одной комнаты. В логах стенда два `Audio recording started` по одному митингу с разницей 529 мс | Резервация до egress и общий предикат `findRunningRecording` для обоих форматов; строка снимается, если egress упал |
| D26 | Polling чинил потерянный `participant_joined` только по своему in-memory кэшу: «есть сейчас, не было в прошлый опрос». После рестарта воркспейс-сессии `ParticipantInfo` (DOMAIN_TRANSIENT, в памяти) стирались, а кэш по-прежнему перечислял всех - места не восстанавливались никогда | Восстановление идёт от базы: у живого участника LiveKit нет строки - создаём. Идемпотентно и не зависит от того, какая реплика что видела |
| D27 | Видеозапись не стартовала на CI: LiveKit-egress не принимал room-composite с Chrome (`web_cpu_cost` по умолчанию 3-4 при 4 vCPU на раннере), запрос висел, и SDK обрывал его своим таймаутом в 10 с - `The operation was aborted due to timeout`. Аудио-egress (cost 1) при этом работал | `cpu_cost` в `tests/livekit-egress-test-config.yaml` снижен до 1; `EGRESS_REQUEST_TIMEOUT_SEC` (по умолчанию 30) задаёт `requestTimeout` для `EgressClient` |

Коллизии координат теперь ещё и закрепляются: `RoomPreview` у создателя
митинга пишет разведённые места обратно через `apply()` + `notMatch` (§6.3),
поэтому раскладка сходится к одной у всех клиентов. Сама первая аллокация в
`upsertParticipantFromLiveKit` по-прежнему неатомарна (read-then-create).

Проверка: `plugins/love/src/__tests__/getFreeRoomPlace.test.ts` (6 тестов),
`services/love` 79 тестов, `server-plugins/love-resources` 19 тестов,
`svelte-check` 0 ошибок.

## 11. Тесты

### 11.1 Unit: `server-plugins/love-resources/src/__tests__/`

| Файл | Что проверяет |
|---|---|
| `userMeetingInvite.knock.test.ts` | Fanout по owner-ам, accept снимает siblings, decline всеми -> `declined`, auth-check |
| `userMeetingInvite.heartbeat.test.ts` | `TxUpdateDoc invite-request` -> touch invite-response; нет response - нет touch |
| `userMeetingInvite.concurrent.test.ts` | Cancel одного request не задевает другие in-flight response той же пары |
| `userMeetingInvite.privateInvite.test.ts` | Invite в приватный митинг |
| `onEventUpdate.test.ts` | Event <-> MeetingMinutes через `MeetingEventLink` (сдвиг даты, участники) |

Запуск: `cd server-plugins/love-resources && npx jest`.

### 11.2 Unit: `plugins/love/src/__tests__/`

`getFreeRoomPlace.test.ts` - границы `pref`, резерв `(0,0)` офиса,
overflow по `x`.

Запуск: `cd plugins/love && npx jest`.

### 11.3 Unit: `services/love/src/__tests__/`

| Файл | Что проверяет |
|---|---|
| `webhook.test.ts` | Обработка webhook-событий |
| `utils.test.ts` | `parseRoomName`, `getRoomName`, токены |
| `edge-cases.test.ts` | Митинг без `roomId`, быстрые join/leave, AI-участники без `sessionId` |
| `finishMeeting.test.ts` | Re-arm scheduled vs терминальный Finished |
| `checkUnfinishedMeetings.test.ts` | Не трогать `Scheduled`, grace-окно |
| `guests.test.ts` | 403 на `Scheduled`/`Finished` |
| `polling.test.ts` | Reconcile, outage-drain |

Хелперы `test-helpers.ts`: `TEST_IDS`, `TEST_TIMESTAMPS`, `createMockContext()`,
`createMockMeeting()`, `createMockParticipant()`, `createMockRoom()`,
`TEST_SCENARIOS`. Моки: `RestClient`, `WorkspaceClient.create()`,
`@hcengineering/server-token` - база и LiveKit не нужны.

`src/__tests__/setup.ts` подставляет env (`ACCOUNTS_URL`, `LIVEKIT_*`, `SECRET`),
потому что `src/config.ts` бросает на отсутствующих переменных прямо при импорте.
Любой тест, тянущий `utils`/`webhook`/`billing`, транзитивно грузит `config.ts`,
поэтому setup подключён через `jest.config.js` -> `setupFiles`.

**`parseRoomName`:** имя LiveKit-комнаты - `${workspaceUuid}_${meetingMinutesId}`.
Обе части машинные и `_` не содержат (UUID v4 и 24 hex-символа из `generateId`),
поэтому единственный `_` - всегда разделитель. Не выдумывайте тесты с
workspace/meetingId, содержащими `_`, unicode или произвольный текст: такие
входы `getRoomName` не производит.

**Gotchas `webhook.test.ts`:** `handleJoinLeave` пропускает агентов по
`participant.kind !== 0`, поэтому мокам нужен `kind: 0`. `processEvent`
глотает ошибки `WorkspaceClient.create` и логирует через `ctx.error`, никогда
не бросая - проверяйте вызов `ctx.error`, а не reject.

Запуск: `cd services/love && npx jest` (или `rushx test`, `rushx test --coverage`).

### 11.4 Integration: `ws-tests/api-tests/src/__tests__/`

| Файл | Что проверяет |
|---|---|
| `love-invite-flow.test.ts` | A2 end-to-end через WS+REST |
| `love-invite-flow.benchmark.test.ts` | 200 итераций x parallel=20 без потерянных tx |

```bash
cd ws-tests/api-tests && rushx api-test --testPathPattern=love-invite-flow

BENCH_INVITE_FLOW=1 BENCH_INVITE_ITERATIONS=200 BENCH_INVITE_PARALLEL=20 \
  rushx api-test --testPathPattern=love-invite-flow.benchmark
```

### 11.5 Sanity Playwright: `tests/sanity/tests/love/`

Все тесты собраны в последовательный suite `meetings.all.spec.ts`, который
импортирует `registerXxxTests()` из соседних `*.tests.ts`. 65 тестов, 1 worker;
один из них ручной (см. ниже).

| Файл | Покрытие |
|---|---|
| `meetings.tests.ts` | Навигация по этажу, office panel, room aside |
| `meetings.access.tests.ts` | Видимость этажа для non-owner ролей |
| `meetings.migration.tests.ts` | Миграция `DOMAIN_MEETING_MINUTES -> DOMAIN_SPACE` |
| `meetings.start.tests.ts` | Создание митинга, broadcast, owner-toggle privacy |
| `meetings.session.tests.ts` | Lifecycle, re-entry, room hop |
| `meetings.connect.tests.ts` | LiveKit-коннект, invite A1, join по ссылке |
| `meetings.client-create.tests.ts` | A2 - caller создаёт митинг после accept |
| `meetings.invite.tests.ts` | Reject, симметричные invite, self-invite filter |
| `meetings.invite-ui.tests.ts` | Лейблы и попапы A1/A2, Cancel/Decline |
| `meetings.scenarios.tests.ts` | Privacy + Busy badge, multi-invite, partial leave, knock-to-join |
| `meetings.knock-office.tests.ts` | Knock в персональный office |
| `meetings.privacy.tests.ts` | Non-owner не видит privacy toggle |
| `meetings.workspace-owner.tests.ts` | Workspace owner self-join в чужой private |
| `meetings.bidirectional-loop.tests.ts` | Forward + reverse call, каскадный disconnect |
| `meetings.guest.tests.ts` | Guest join по ссылке, видимость гостя хосту, два гостя, отказ после Finished |
| `meetings.devices.tests.ts` | Выбор микрофона: muted join, пропавшее устройство |
| `meetings.network.tests.ts` | Деградация линка до LiveKit: задержка, обрыв, полный offline |
| `meetings.presence.tests.ts` | Размещение на сетке этажа, разрешение коллизий координат |
| `meetings.scheduled-links.tests.ts` | Гостевая ссылка, ранний старт, poll-цикл |
| `meetings.refresh-reconnect.tests.ts` | Reconnect после refresh, explicit leave |
| `meetings.host-refresh.tests.ts` | F5 владельца офиса не выкидывает остальных (D7) |
| `meetings.scheduled-connect.tests.ts` | Connect не «оживляет» будущий `Scheduled` (D4) |
| `meetings.finished-token.tests.ts` | `/getToken` отвергает `Finished` (D10), без браузера |
| `meetings.transactor-restart.tests.ts` | Присутствие переживает force-close воркспейс-сессии. **Только вручную**: `LOVE_MANUAL_TESTS=true` |
| `meetings.recording.tests.ts` | Старт/стоп записи и плашка, конкурентный `/startRecord` (D18), тумблер транскрипции (D20) |

#### Запуск

```bash
# 1. Docker-стек (Postgres, MinIO, Elastic) + пользователи и workspace
cd tests && ./prepare-pg.sh

# 2. Front/server на порту 8083 (docker-compose или rush dev)

# 3. LiveKit (обязателен для join/leave тестов)
cd dev && ./run_livekit.sh     # порт 7880, webhook http://127.0.0.1:8098/webhook
                              # ключи devkey/devkey2, конфиг dev/livekit-dev-config.yaml
                              # на Mac host-network недоступна, LiveKit поднимается локально

# 4. Тесты
cd tests/sanity
rushx ci                                          # установка браузера, первый раз
rushx uitest tests/love/meetings.all.spec.ts --reporter=list --retries=0 --workers=1
rushx uitest tests/love/meetings.all.spec.ts -g "knocker auto-joins" --reporter=list --retries=0
rushx debug tests/love/meetings.all.spec.ts       # headed

# Ручной тест: сносит сессию общего meetings-ws, поэтому в обычный прогон не входит
LOVE_MANUAL_TESTS=true rushx uitest tests/love/meetings.all.spec.ts -g "workspace session restart" --workers=1
```

`rushx uitest` оборачивает `playwright test` нужным env (`LOCAL_URL`, `DEV_URL`)
и конфигом - всегда предпочтительнее голого `npx playwright`.
`--reporter=list --retries=0` обязательны для dev-прогонов: html-репортер
поднимает локальный сервер и блокирует терминал (выглядит как зависание),
а ретраи по умолчанию тратят минуты на перезапуск настоящего падения.

Перед прогоном после изменений кода: `rush fast-build:docker`, затем
`cd tests && ./prepare-pg.sh` (пересоздавать стенд целиком, не рестартить
один контейнер).

#### Окружение и соглашения

- Workspace `meetings-ws` (не `sanity-ws`); пользователи `user1`
  (John Appleseed) и `user2` (Kainin Dirak), пароль `1234`.
- Auth-setup выполняется автоматически в `.auth/storage.json`; удалите `.auth/`
  для повторной авторизации.
- Конфиг `tests/sanity/tests/playwright.config.ts`, `testIdAttribute: 'data-id'`,
  таймауты test=60s / expect=15s, Desktop Chrome 1440x900.
- Page objects в `tests/sanity/tests/model/love/`: `office-page.ts`,
  `meeting-minutes-page.ts`, `index.ts`. Наследуют `CommonPage`,
  локаторы - стрелочные функции.

Существующие `data-id`: `meeting-name-input`, `meeting-toggle-private`,
`meeting-connect`, `meeting-leave`, `room-enter`, `room-{name}`, `busy-badge`,
`recording-button`, `transcription-button`, `pending-recording`.
Для `ModernButton` используйте проп `dataId`, иначе атрибут `data-id`
напрямую. Нейминг: `meeting-*` для панели митинга, `room-*` для элементов комнаты.

---

### 11.6 Что покрыто и что нет

Матрица по разделам этого документа. «Unit» - jest, «E2E» - Playwright.

| Область | Unit | E2E | Оценка |
|---|---|---|---|
| §2 Модель, парсинг room name | `utils.test.ts`, `edge-cases.test.ts` | - | Достаточно |
| §3 Безопасность private-митинга | `guests.test.ts` (403/404) | `privacy`, `scenarios`, `workspace-owner` | Достаточно |
| §4 Жизненный цикл, автозавершение | `checkUnfinishedMeetings`, `finishMeeting` | `start`, `session`, `scheduled-links` | Достаточно |
| §5 Подключение, reconnect | `webhook.test.ts`, `polling.test.ts` | `connect`, `refresh-reconnect`, `network` | Достаточно |
| §5.4 Деградация сети до LiveKit | - | `network` (задержка, обрыв, offline) | Базово |
| §6 Присутствие и сетка | `getFreeRoomPlace.test.ts` | `presence` | Базово |
| §7 Invite / Knock | 4 файла в `server-plugins/love-resources` | `invite`, `invite-ui`, `knock-office`, `client-create`, `bidirectional`, `scenarios` | Достаточно |
| §8 Гости | `guests.test.ts` | `guest` (4 сценария) | Базово |
| §9 Запись и транскрипция | `recordings.test.ts` | `recording` (3 сценария) | Базово |
| Выбор устройств | `plugins/media/src/__tests__` | `devices` | Базово |

**Пробелы, известные и осознанные:**

1. **Запись и транскрипция (§9)** - покрыты старт/стоп, `PendingRecording`,
   конкурентный `/startRecord` и тумблер транскрипции. Остаются непокрытыми:
   webhook-и `egress_*` (в `webhook.test.ts` их нет), сохранение файла в storage
   и его дальнейшая судьба, `startWithRecording` по событию очереди, отказ по
   исчерпанному лимиту диска (413).
2. **Переполнение офиса** - `getFreeRoomPlace` покрыт unit-тестом, но e2e на
   «владелец + два стучащихся в офис 2x1» нет: `presence` проверяет коллизии
   через синтетические `ParticipantInfo`, а не через реальный knock.
3. **Медиа-канал** - тесты `network` бьют только по сигнальному WebSocket.
   Потеря пакетов и деградация RTC-портов (7891/7892) не моделируются.
4. **CRUD этажей и комнат** - создание, удаление, переименование, смена
   `RoomType`, запрет удаления этажа с комнатами.
5. **Screen sharing** - не покрыт ни на одном уровне.
6. **Гости**: не покрыты private-митинг, отзыв ссылки, `Scheduled` до старта
   (есть только unit на 403), поведение гостя при обрыве связи.

---

## 12. QA-сценарии

Не покрытое автоматикой или требующее визуальной проверки.

**12.1 Навигация.** Office загружается, видны комнаты и персональные офисы.
Свой office -> aside с Meeting minutes. Чужой -> без секретных полей.
Свободная комната -> aside с кнопкой Connect.

**12.2 A1.** A подключается к Meeting Room 1, шлёт invite B. У A лейбл
«You are inviting» + аватар B, у B - «Knocking» + аватар A. B открывает
триггер -> «{A} is asking you to join» -> Join -> оба в митинге, триггеры
исчезли. Cancel-путь: A жмёт Cancel -> у B пропадает incoming. Reject-путь:
B жмёт Reject -> у A toast «{B} declined».

**12.3 A2.** Оба online, никто не в митинге. A кликает аватар B в его office
cell -> PersonActionPopup -> «Invite to call». У B incoming -> Join ->
мелькает «Waiting for {A}» -> A создаёт митинг в своём офисе -> оба auto-join.

**12.4 Knock.** A делает свой офис private. B видит Busy badge без названия
митинга, в aside - кнопка Knock. B жмёт Knock -> у B «Knocking to {A}»,
у A в виджете KnockingList «{B} is knocking...» + Admit/Decline. Admit ->
B подключается. Decline -> у B toast «Your knock was declined».

**12.5 Multi-owner knock.** Private митинг с двумя owner-ами. C стучится,
запись видят оба. A принимает -> C подключается, у B запись исчезает.

**12.6 Multi-tab guard.** B залогинен в двух вкладках. A зовёт B. Join в
вкладке 1 -> вкладка 2 видит `accepted`, но **не** подключается.

**12.7 Каскад по уходу владельца.** A в своём офисе, B присоединился.
A жмёт Leave -> через ~3-5 с B автоматически отключается.

**12.8 Heartbeat / TTL.** A зовёт B, B видит триггер. A **жёстко закрывает
вкладку** (Cmd+W, не Leave и не Cancel) -> через ~30 с триггер у B пропадает сам.

**12.9 Privacy + Busy badge.** A в private митинге, B видит Busy badge без
названия. A жмёт «Open room» -> badge исчезает, название появляется.

**12.10 Размещение участников.** Зайти в чужой офис третьим человеком -
все трое должны быть видны (третий в overflow-колонке). Зайти по гостевой
ссылке и по invite - участник обязан появиться в комнате, а не «пропасть».

**12.11 Refresh.** Участник обновляет вкладку во время митинга - он остаётся
в комнате и в списке участников, дублей `ParticipantInfo` нет.

**12.12 Миграция backup.** Развернуть workspace из старого backup-а
(`MeetingMinutes` в `DOMAIN_MEETING_MINUTES`), дождаться миграции, проверить
записи митингов, `ActivityMessage`/`Attachment` в правильном space,
работающую транскрипцию.

**12.13 Guest join.** Хост создаёт shared link, гость открывает в incognito ->
форма -> Join meeting -> виджет митинга без Abort handler в консоли.

**12.14 RPC-коды.** Без токена -> 401. Невалидный токен -> 401. Недоступный
workspace/митинг -> 403. Несуществующий документ -> 404.

**12.15 `ensurePerson` под нагрузкой.** Скрипт регистрирует одного гостя N раз
параллельно - должен получиться единственный Person, без orphan-ов.

**12.16 UI-шум.** В консоли браузера нет необработанных `pageerror`. Аватар
в `InviteButton` центрирован по вертикали относительно текста.
