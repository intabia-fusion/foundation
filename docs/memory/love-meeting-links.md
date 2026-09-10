# Ловушки: guest-ссылки, RSVP, миграции love (FUSIO-1307)

- `getWorkspaceId` в `services/love` - аутентификация, не авторизация: отсекает только guest/readonly.
  Любой эндпоинт, принимающий `eventId`/`meetingId`, обязан звать `findMeetingTarget` +
  `isMeetingParticipant`. Было пропущено в `/resolveSession` и `/guestToken`.
- Вход в встречу два: pointer-ссылка и JWT (`/guestToken`, клиент зовёт его до сих пор). Новая
  проверка на одном пути = дыры нет только на нём. JWT резолвится через `meeting.eventId`, то есть
  даёт всю серию, а не одно вхождение.
- Копия события у участника - это `{ ...master, calendar, access, user }`. `participants` одинаков
  во всех копиях; различает копии только `user`. Ключевать по `participants[0]` = схлопнуть всех.
- Организатор всегда в `participants` своего события, но никогда не отвечает - счётчики "сколько
  ещё не ответили" должны его вычитать.
- Невыгруженное вхождение серии (`virtual: true`) имеет сгенерированный на лету `_id`:
  `client.update` по нему уходит в никуда. Только `updateReccuringInstance`.
- `access: AccessLevel.Owner` не значит "мастер": `updateReccuringInstance` материализует
  override с `Owner` и тем же `eventId`. Запросы "найди мастера" должны исключать
  `calendar.class.ReccuringInstance`.
- Стейты миграции читают друг друга: удаляя поле из раннего трансформа, проверить, кто читает его
  позже (`meetingScheduledDate` -> `occurrence`).
- Плоское окно `lookahead` хоронит редкие серии: у YEARLY `next` не находится, и `checkMeetingLink`
  начинает отсчёт `afterTtl` по живой ссылке. Окно считать от периода правила.
- Мок, не совпадающий с тем, что реально пишет сервер, - не тест: `rsvp.test.ts` был зелёный при
  сломанном `collectRsvp`, потому что строил `participants: [who]`.

Тесты в `meetings-ws` не чистятся сами - см. [[sanity-flaky-tests]].
