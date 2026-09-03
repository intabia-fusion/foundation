# Смена пространства убивает звонок (PROD-инцидент)

Цепочка, из-за которой переключение воркспейса завершало встречу у всех участников
и не давало вернуться обратно:

1. `plugins/love-resources/src/components/WorkbenchExtension.svelte` — `onDestroy`
   безусловно зовёт `liveKitClient.disconnect()`, минуя `leaveMeeting()`.
2. `services/love/src/webhook.ts` (`participant_left`) — если ушедший является
   владельцем офиса, в метаданные LiveKit-комнаты пишется `ownerLeftAt`.
3. `services/love/src/polling.ts` `closeRoomIfOwnerGone` — по истечении
   `OWNER_REJOIN_GRACE_SEC` (дефолт **15 с**, `services/love/src/config.ts`)
   вызывает `roomClient.deleteRoom`, выкидывая всех оставшихся.
4. `deleteRoom` → LiveKit `room_finished` → `webhook.ts` `finishMeeting` →
   `MeetingStatus.Finished`. Присоединиться к этой встрече больше нельзя.
5. Клиентский блокер возврата: `currentMeeting` в `meetings.ts` — модульная
   переменная, а смена пространства это SPA-навигация без перезагрузки. Чистится
   только в `leaveMeeting()`, поэтому оставалась протухшей, и `connectToMeeting`
   молча выходил на `if (currentMeeting === mm._id) return`.

## Связанный побочный эффект

Массовый кик приводит к `disconnect()` с уже мёртвой комнатой. До фикса
`Promise.all([setScreenShareEnabled(false), setCameraEnabled(false),
setMicrophoneEnabled(false)])` реджектился и `currentMediaSession.close()` не
выполнялся. Сессия оставалась в глобальном сторе `plugins/media-resources/src/stores.ts`,
где `state.microphone.enabled` считается как OR по всем сессиям — отсюда навсегда
залипшая кнопка микрофона при работающем микрофоне.

Второй путь той же утечки: `connect()` защищён только флагом `lkSessionConnected`,
который выставляется в `onConnected`. Два `connect()` до `Connected` создавали
вторую `MediaSession`, не закрыв первую.

## Принятое решение

Серверную логику `closeRoomIfOwnerGone` не трогали — вместо этого перед сменой
пространства показывается подтверждение (guard `addLeaveWorkspaceGuard` /
`canLeaveWorkspace` в `packages/presentation/src/utils.ts`, реализация
`confirmSwitchWorkspace` в `love-resources/src/switchWorkspaceGuard.ts` - отдельный модуль,
потому что `@hcengineering/ui` тянет `.svelte`, а jest их не парсит: импорт из `meetings.ts`
ронял три существующих теста). Владельцу офиса
текст говорит, что встреча завершится для всех. Точки входа смены пространства:
`AccountPopup.svelte` и `SelectWorkspaceMenu.svelte`.
