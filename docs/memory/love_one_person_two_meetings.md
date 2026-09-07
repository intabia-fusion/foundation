# Один человек в двух митингах (FUSIO, 0.8.37)

Симптом из баг-репорта: «комната с Юлей не закрывается даже после рефреша» после перехода
в другой митинг через приглашение-звонок.

## Что показали логи staging (`love-service`, `aibot-service`, `love-agent-service`)

```
07:20:13  user "2,1"  joined  meeting A
08:00:26  user "2,1"  joined  meeting B     <- перешёл, не выйдя из A
08:10:03  user "2,1"  left    meeting A     <- только через 9.5 минут
08:10:23  room A closed (departureTimeout 20s), Юля вышла, meeting finished
```

Love-сервис отработал корректно. Комната A была законно занята живой сессией человека.

## Почему в UI выглядело как «только Юля»

`plugins/love-resources/src/stores.ts` `filterParticipantInfo` схлопывает несколько
`ParticipantInfo` одного person в самую свежую. Строка из A скрывалась, потому что свежая
была в B. Комната A показывала только AI-бота.

Отсюда же следствие: клиент в принципе не мог обнаружить вторую свою сессию - store уже схлопнут.
Поэтому добавлены `allInfos` (сырой список) и `myInfos`.

## Ложная гипотеза, которую пришлось отбросить

Сначала подозревали, что love-agent (`kind: AGENT`) удерживает комнату живой и `room_finished`
не приходит. Проверено на стенде: LiveKit 1.13.6 закрывает комнату через `departureTimeout`
после ухода последнего STANDARD-участника, agent и egress её не удерживают. Playwright-тест
на этот сценарий проходил и на сломанном коде - удалён. `closeRoomIfAgentsOnly` в
`polling.ts` остался как безвредная подстраховка (комментарий в коде это прямо говорит), но
исходный баг лечит не он. Он же не штампует комнату моложе grace: агент попадает в комнату
раньше, чем поднимется WebSocket первого участника (у того 20 c таймаута).

## Принятое решение

- Заслон на сервере: `POST /claimSession` (`services/love/src/main.ts` -> `sessions.ts`)
  выкидывает прежние LiveKit-сессии этого person в других митингах воркспейса
  (`removeParticipant`). ParticipantInfo подчищает штатный `participant_left` webhook.
  Клиент зовёт его ПОСЛЕ успешного `liveKitClient.connect`, иначе провалившийся connect
  стоил бы пользователю митинга, в котором он ещё сидит. Не на `/getToken`.
- Person берётся из bearer-токена (`resolveCaller` -> `findPersonByAccount`), НИКОГДА из
  `body._id`: иначе любой в воркспейсе выкинул бы другого из его встречи.
- Клиент: `findOtherLiveSession` (`otherSession.ts`, без `@hcengineering/ui`) находит кандидата,
  `POST /liveSessions` подтверждает, что LiveKit его правда держит, и только тогда
  `confirmLeaveOtherMeeting` (`loveGuards.ts`, подгружается динамически) показывает MessageBox
  «Вы уже находитесь во встрече ... Продолжить и выйти оттуда?».
- Почему нужен `/liveSessions`: ParticipantInfo переживает закрытую вкладку на `departureTimeout`
  (20 c), и клиент не отличает живую вторую вкладку от остатка. Эвристики (sid вкладки в
  sessionStorage, `ownTab`) отсекают только свои же строки.
- `meetings.ts` не должен статически импортировать `loveGuards.ts`: `@hcengineering/ui` тянет
  `.svelte`, jest их не парсит, и это роняет три существующих теста. Отсюда деление
  `otherSession.ts` (чистый) / `loveGuards.ts` (попап, динамический import).
- Тест: `tests/sanity/tests/love/meetings.multitab.tests.ts` (два контекста, один storageState).

Кросс-воркспейсный случай НЕ покрываем: в разных пространствах разные `personRef`, общей нити
в LiveKit нет (identity = personRef, account uuid в metadata токена не кладётся). Считаем
легитимным сценарием.

Телефон -> ноутбук в ОДНОМ митинге проходит молча: evict пропускает свой же митинг, LiveKit
вытесняет старую сессию по duplicate identity, а `removeParticipantFromLiveKit` скоупится по
`sessionId`, поэтому запоздалый `participant_left` не снесёт свежую строку.

## Осталось незакрытым

1. `invites.ts:518` `checkAndJoinIfRecipientJoined` не фильтрует по `acceptedSessionId` -
   все вкладки ОТПРАВИТЕЛЯ лезут в митинг, для A2 каждая зовёт `createMeeting`.
   Это «принял в одной вкладке, стартовал в другой».
2. Фильтр получателя `acceptedSessionId !== undefined && ...` разваливается при пустом
   `presentation.metadata.SessionId` - тогда джойнят все вкладки.
3. Множественные «Стучится» на одного человека: `notMatch` в `sendKnockRequest`
   (`invites.ts:224`) не отсекает быстрые повторы.
