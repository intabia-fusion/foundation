# Billing dev stand quirks (2026-07-04)

## Относительные BILLING_URL/PAYMENT_URL (config.json)
- BillingClient/PaymentClient строят `new URL(endpoint+path)` - относительный `/_billing` бросает `Invalid URL`. Резолв в `billing-resources/utils.ts:absoluteUrl()` через window.location.origin.
- webpack dev-server прокси: `/_payment` добавлен в devProxy (8087) и devProxyTest (8083); без него fetch plan-config получал index.html ("Unexpected token '<'").

## Дрейф схемы billing-БД между ветками
- Симптом: 500 на `/_billing/.../stats`, в логах пода `column "day" does not exist`.
- Причина: dev postgres volume мигрирован другой веткой (foundation AI-billing: ai_tokens_usage c hour/provider_id/model/level). Миграции versioned + CREATE TABLE IF NOT EXISTS => схема не пересоздаётся.
- Лечение: DROP TABLE billing.ai_tokens_usage и создать вручную по migrationV2 (workspace, day, reason, total_tokens; PK workspace+day+reason; index day).
- При rebase FUSIO-886 (hour-based schema) конфликт схем всплывёт снова - решать миграцией, не IF NOT EXISTS.

## Stale bundle cache (fast-build:docker) — 2026-07-18
- Симптом: код правки в pod (lib/*.js свежий) НЕ попадают в docker образ. `fast-build:docker` пишет "Bundled N from cache", образ latest старый (проверять `docker images ... CreatedSince`).
- Причина: прерванный (teardown/kill) fast-build оставляет несогласованный `.fast-build-cache.json` -> bundle не пересобирается, docker берёт stale `bundle/bundle.js` (mtime старее lib/).
- Диагностика: `grep -c <новый_символ> bundle/bundle.js` (0 = stale); сравнить mtime bundle.js vs lib/*.js.
- Лечение: `rm .fast-build-cache.json && pnpm run bundle && pnpm run docker:build` в pkg-каталоге, затем `docker compose up -d --force-recreate <service>`. Проверить bundle внутри контейнера: `docker exec <c> grep -c <символ> /app/bundle.js`.

## tbank ledger через queue (payment-operation topic)
- tbank-subscriptions logOperation (best-effort try/catch) -> publishOperation -> Kafka topic `payment-operation` -> account-service consumer groupId `payment-operation-payment-ledger` -> `global_account.payment_operation` (append-only, id=gen_random_uuid).
- Проверка связки: seat change 3->5 = init_charge NEW + webhook CONFIRMED + cancel PLAN_CHANGE (старая подписка). `docker exec dev-postgres-1 psql -U postgres -d postgres -c "SELECT operation,status,payment_id,amount FROM global_account.payment_operation ORDER BY created_on DESC"`.
- Overlay стенд: `rush docker:up:tbank` (PROVIDER=tbank, TBANK_MOCK=true). Mock checkout: `/_tbank_subscriptions/mock-checkout/:paymentId`, кнопки Оплатить/Отменить шлют CONFIRMED/REJECTED webhook.
- payment_operation table = миграция v31 (account_db_v31_payment_operation_ledger).
