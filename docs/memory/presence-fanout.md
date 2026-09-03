# Presence: рассылка на каждый workspace

Найдено при разборе телеметрии sanity 2026-08-31.

## Что было

`handlePresenceBatch` (`server/account-service/src/presence.ts`) на каждое событие presence
(login, смена статуса непрочитанного) строил один `tx` и отправлял его в очередь **по разу на
каждый workspace пользователя**. Payload у всех отправок одинаковый: полная карта непрочитанного
уже лежит в `tx.attributes`.

На приёме `sessionManager` брал `workspaceUuid` из сообщения и молча отбрасывал его, если
workspace не загружен или у аккаунта там нет сессии. За прогон: 17305 отправок, 582 применённых -
96.6% в мусор. Маршрутизации по ключу при этом нет вовсе: `createConsumer(..., this.transactorId)`
даёт каждому транзактору свою consumer group, то есть все партиции он читает в любом случае.

Цена росла линейно с числом workspace на аккаунте: `users-consumer/handle-msg` 10.1 -> 16.7 ms
за два прогона, из них 84% - последовательные `await producer.send()`.

## Что стало

`QueueOnlineUserTx` больше не содержит `workspaceUuid`, сообщение адресовано аккаунту. Отправка
одна, ключ партиции - account uuid (порядок обновлений пользователя сохраняется). Consumer идёт от
сессий: обходит `this.sessions`, собирает workspace, где у аккаунта есть сессия, применяет tx в
каждом. Замер после: `users-consumer/handle-msg` 4.4 ms на вызов, producer ушёл из топ-200 stats,
транзактор применил 608 tx против 588 - ничего не потеряно.

Несовместимо со старым транзактором на время rolling deploy: он ждёт `workspaceUuid` и без него
сообщение отбросит.

## Второе место, не исправлено

`workspace_members` проиндексирована только `(workspace_uuid, account_uuid)`, поэтому поиск по
`account_uuid` идёт Seq Scan'ом. На каждый логин таких запросов два: `getAccountWorkspaces` и
`getWorkspaceRoles`. Нужен индекс - рядом с `workspace_permissions_account_idx` в
`server/account/src/collections/postgres/migrations.ts`, где та же проблема уже решена:

```sql
CREATE INDEX IF NOT EXISTS workspace_members_account_idx
  ON ${ns}.workspace_members (account_uuid) INCLUDE (workspace_uuid, role);
```

Третье, структурное: `getLoginWithWorkspaceInfo` отдаёт клиенту все активные workspace с
endpoint'ами, ролями и branding. При 92 workspace это 92 записи в ответе на каждый логин.
