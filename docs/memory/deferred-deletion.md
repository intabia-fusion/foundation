# Отложенное удаление пространств и аккаунтов

Спека: `foundation-tasks/docs/admin/2026-09-10-101-deferred-deletion.md` (блок TSK-2026-09-10-101..200).

## Модель

Две колонки `delete_on` (миграции v42 workspace_status, v43 account) вместо новых режимов.

Пространство: `deleteOn` выставлен, mode остаётся `active` -> 7 дней readonly -> планировщик
переводит в `archiving-pending-backup` -> `archived` -> в `deleteOn` переводит в `pending-deletion`.
`archived` без `deleteOn` - это по-прежнему ручной архив админа, он не истекает.

Аккаунт: только метка, ничего не чистится. Логин работает, `LoginInfo.deleteOn` заставляет клиента
спросить, отменять ли удаление. `cancelAccountDeletion` - явное действие, автоотмены на входе нет.

## Что переиспользовано, а не написано

- Readonly: `extra.readonly === 'true'` в токене. Транзактор режет все транзакции
  (`foundations/server/packages/server/src/client.ts:263`), collaborator открывает документы на
  чтение (`server/collaborator/src/extensions/authentication.ts:45`).
- Архивирование и восстановление: существующая цепочка `archiving-*` -> `archived` -> `unarchive`.
- Отказ во входе для архива: транзактор на `isArchivingMode`
  (`foundations/server/packages/server/src/sessionManager.ts:679`).

## Ловушки, найденные по ходу

- `selectWorkspace` намеренно выдаёт токен архивированного пространства: `performWorkspaceOperation`
  требует токен того же пространства (`serviceOperations.ts:921`), и без этого токена `unArchive`
  из UI не вызвать. Добавлена альтернатива - проверка роли Owner на целевом пространстве.
- `doCleanup` (`server/workspace-service/src/service.ts:408`) игнорирует параметр `cleanIndexes` и
  всегда сносит только БД. Блобы не удаляет ни архивирование, ни удаление - открытый хвост
  TSK-2026-09-10-166.
- Очистка поля через `undefined` в `Operations<T>`: `buildUpdateClause` берёт `Object.keys(ops)`,
  так что ключ со значением `undefined` попадает в SET и становится NULL.
- В тестах `process.env.X = undefined` записывает строку "undefined" и ломает `parseInt` в
  последующих тестах - восстанавливать через `delete`.
- Ожидаемые SQL-строки в `postgres.test.ts` перечисляют колонки статуса буквально: любое поле в
  json_build_object нужно добавить и туда.

## Конфигурация

`DELETION_GRACE_DAYS` (21), `DELETION_READONLY_DAYS` (7) - account-service.
`DELETED_RETENTION_DAYS` (было 7, стало 1) - backup pod; 0 и меньше выключает чистку архива,
этим пользуется одноразовый пайплайн workspace-service.

## CI PR #434

Падения uitest-pg и uitest-qms (auth.setup: страница логина в бесконечном reload) - не от этой
работы. Ветка была собрана до `f7d6499abd fix webpack error` (develop, 2026-09-10 21:06), который
добавляет `rootDir`/`include`/`exclude` в `dev/prod/tsconfig.json`. Механика: фронтовый чанк логина
не грузится -> `LoadHelper` (`dev/prod/src/platform.ts:440`) после 5 попыток делает
`location.reload()`. Лечится ребейзом на develop.

uitest-workspaces - это `ws-tests/api-tests`, там падал `identity-deletion.test.ts`, написанный под
немедленное удаление. Переписан под отсрочку.
