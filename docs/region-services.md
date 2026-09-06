# Сервисы: региональные vs глобальные

Регион = полный набор сервисов обработки пространств (возможно отдельный k8s-кластер и свой kafka).
Kafka-топики региональны: `${region}.<topic><postfix>`. Внутри региона producer/consumer делят один
`REGION`/`QUEUE_REGION` - согласованность автоматическая. Выделенный регион возможен вплоть до одного
пространства (region-config, workspaces override).

## Региональные (набор на каждый регион)

Обрабатывают данные пространств своего региона, читают/пишут региональные топики (`tx`, `workspace`,
`fulltext`, `users`, `online-user-tx`, `workspace-wakeup`, `process`, `love-queue`, `ai-queue`,
`transcription-queue`, `billing-usage`, `timeMachine`).

| Сервис | Роль | Ключевые топики |
|---|---|---|
| transactor | пайплайн транзакций | prod: tx, users, billing-usage; cons: workspace, online-user-tx |
| collaborator | совместное редактирование | - (websocket) |
| workspace (workspace-service) | create/upgrade/backup/delete | cons: workspace-wakeup; prod: workspace |
| fulltext | индексация | cons: tx, fulltext, workspace |
| notifications | inbox-уведомления | cons: tx; prod: users |
| activity | лента активности | cons: tx |
| translate | автоперевод | cons: tx |
| media | обработка медиа | cons: tx |
| rating | рейтинги | cons: tx, workspace |
| love | митинги/звонки | cons: tx, workspace, love-queue; prod: billing-usage |
| ai-bot | ЮляИИ | cons: workspace, ai-queue, love-queue, transcription-queue |
| datalake | файлы пространств | cons: workspace (limits) |
| process | процессы | cons: process |
| gmail / mail-worker | почтовые интеграции пространств | cons: tx |
| backup, backup-api | бэкапы пространств | - |
| worker (time-machine) | отложенные задачи | cons: timeMachine |
| stream, hulygun, preview | файловые пайплайны | - |
| billing | учёт usage своего региона | cons: billing-usage, workspace; used пишет в account (глобальная БД) |
| telegram-bot | Telegram-интеграция (ПОКА НЕ АКТУАЛЕН) | cons: telegramBot. Нюанс на будущее: один bot-token не может polling-иться двумя подами - нужен webhook-режим или token на регион |
| calendar-mailer | календарные письма (ПОКА НЕ АКТУАЛЕН) | cons: calendarEventCUD |

## Глобальные (один на инсталляцию)

Работают с глобальными данными (account_db, биллинг) или внешними API ("типа почта").

| Сервис | Роль | Топики и регион-требования |
|---|---|---|
| account | единственный кросс-региональный | ПИШЕТ в регион пространства: workspace, fulltext, online-user-tx, workspace-wakeup (регион знает из workspace.region); ЧИТАЕТ из всех известных регионов: users; глобальные пары: notifications, crm (prod), payment-operation (cons) |
| mail (pod-mail) | SMTP-отправка | cons: notifications (глобальный топик от account) |
| crm | amoCRM-интеграция | cons: crm |
| payment | платежи; SINGLE writer baked limits в account_db | cons: subscription (глоб. пара), workspace - ТРЕБУЕТ подписки на все регионы (Created/Up для провижининга free/trial); prod: payment-operation (глоб. пара с account) |
| tbank-subscriptions | рекурренты ТБанк (один терминал банка) | prod: payment-operation, subscription (глоб. пары с payment/account); cons: tbank-webhook |
| front, stats | UI / статистика | без kafka (front роутится через account endpoints) |

## Следствия

1. Kafka ОДНА на инсталляцию и доступна из всех регионов (как account); регионы разделяются только
   префиксом топика. Стенды (staging/prod) разделяются postfix из queueConfig.
2. Глобальные консюмеры региональных топиков подписываются на топики всех регионов ОДНИМ
   consumer'ом (createConsumer/createBatchConsumer принимают массив топиков; при массиве kafka
   groupId = `${groupId}${postfix}` вместо исторического `${topic}-${groupId}`).
   account: users - СДЕЛАНО (getRegions() из region-config); payment: workspace - СДЕЛАНО
   (список регионов берёт у account через getRegionInfo при старте).
3. Account пишет workspace-скоупнутые события в `${workspace.region}.<topic>` через кросс-региональный
   инстанс очереди (`getPlatformQueue(id, '')` + `getRegionTopic`) - СДЕЛАНО для workspace/fulltext/
   online-user-tx/workspace-wakeup. Presence учитывает, что пользователь online в пространствах разных
   регионов. Maintenance - broadcast во все регионы.
4. Глобальные топики (notifications, crm, subscription, payment-operation, tbank-webhook) живут на
   "домашнем" REGION-префиксе глобальных сервисов - для них ничего не меняется.
5. Payment глобальный сознательно: он SINGLE writer baked limits в account_db (per-region payment
   ломал бы этот инвариант), регионального состояния у него нет. Вся цена - multi-region consumer
   workspace-топика для провижининга подписки на Created/Up.
