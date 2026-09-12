# Удаление аккаунта и пространства

## Что было сломано (репро в тестах)

- `deleteAccount` не трогал `person` и `social_id` (только сбрасывал `verifiedOn`). Email оставался занят мёртвой персоной: `signUpByEmail` находил старый EMAIL social_id, видел `existingAccount === null`, переиспользовал ту же `person` и падал на `duplicate key ... social_id_key_unique` внутри `createAccount`.
- Гвард "единственный owner" ходил в `db.getAccountWorkspaces`, который джойнит `workspace_members` без фильтра по режиму. Строки членства при `delete-done` не удаляются, tombstone `workspace` живёт вечно -> после удаления пространства аккаунт нельзя было удалить **никогда**, отказ `Forbidden` без объяснения.
- v0.8.33 (прод на момент разбора) дополнительно не имел `case 'delete-started'`/`'delete-done'` в `updateWorkspaceInfo` - оба падали в `default`, `mode` навсегда оставался `pending-deletion`, воркер молотил пространство 4 раза и выпадал по `processing_attempts <= 3`. Починено в `e2f833376d` (FUSIO-1287), доехало в v0.8.35.

## Принятая семантика purge

`person` и `social_id` **не удаляются**, а обезличиваются - строки нужны, потому что на `person` ссылаются `workspace.created_by`/`billing_account` (FK без ON DELETE), а `_id` социального идентификатора продолжает резолвиться в данных пространств:

- `social_id`: `value` -> `value#<_id>`, `isDeleted: true`, `verifiedOn` сброшен. Идентификатор не переиспользуется, но по чистому email больше не находится - email свободен для новой регистрации.
- `person`: `firstName`/`lastName`/`phoneHint` очищены, строка остаётся.
- Hard delete: `account` (+`account_passwords` явным DELETE, FK без CASCADE), `workspace_members`, `user_profile`, `mailbox`/`mailbox_secrets`, `integrations`/`integration_secrets`.

Зануление `created_by` не понадобилось: при soft-purge `person` FK ни во что не упирается.

## Гвард

Одно правило для self и админа: нельзя удалить аккаунт, пока человек - единственный owner пространства, **не** находящегося в `isDeletingMode`. Вынесено в `findOrphanedWorkspaces` (`server/account/src/operations.ts`), наружу торчит read-only RPC `canDeleteAccount` - по нему UI решает, показывать ли ссылку.

## Не удаляется при удалении пространства

Дропается только БД (`// We should remove DB, not storages.` в `server/workspace-service/src/service.ts`). Остаются: блобы в S3/datalake (потребителя `QueueWorkspaceEvent.Deleted` там нет), бэкапы (backup-воркер только пропускает неактивные через `isActiveMode`, `deleteRecursive` у S3-стораджа - заглушка), строки `workspace`/`workspace_status`/`workspace_members`/`workspace_permissions`.

## Тесты

- `server/account/src/__tests__/deletion-real.test.ts` - реальная БД (postgres 5433 из ws-tests), инварианты purge и FK.
- `ws-tests/api-tests/src/__tests__/identity-deletion.test.ts` - сквозной путь через админский RPC, требует поднятый стенд на 8083.
