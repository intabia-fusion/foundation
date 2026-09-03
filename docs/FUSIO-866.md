# Review: PR FUSIO-886 (ai-bot / billing rework)

- Base: `develop` (merge-base `036202d`), head `b3ddb610c7`, ~274 files, +17.6k/−2.9k.
- Порядок работы: находки пронумерованы, разбираем по очереди (сверху вниз в каждом блоке — от более серьёзных к нитам).
- Статусы: ⬜ open · ✅ fixed · ⏭️ skipped (с причиной в комментарии).

## План review (батчи)

| # | Область | Статус |
|---|---------|--------|
| 1 | `services/billing/pod-billing`, `packages/billing-client` | ✅ ревью, находки B1–B17 |
| 2 | `services/payment`, `server/account`, `server/core` (events/queue) | ✅ ревью, находки P1–P8 |
| 3 | `services/ai-bot/pod-ai-bot`, `models/ai-bot`, `plugins/ai-bot*` | ✅ ревью, находки A1–A5 |
| 4 | UI: `plugins/billing*`, `plugins/admin*`, `plugins/chunter*`, i18n | ✅ ревью, находки U1–U4 |
| 5 | tests / docs / config (skim) | ✅ ревью, находки C1–C5 |

---

## Батч 1 — billing pod

### B1. `src/limits.ts`

- [x] **B1.1** ✅ исправлено 16.08: `maybeNotifyWindowStep(ctx, ws, amount, subs)` принимает subs от `applyDelta` — второй round trip в account убран; шаг считается от tierUsed (за вычетом absorbed).
- [ ] **B1.2** ❓ `limits.ts:335` `grantPeriodAnchor` + `computeUsed` (limits.ts:~247): якорь окна = самый ранний `periodStart` среди **Active** пакетов. Если пакет остаётся `Active` после конца своего месяца (нет автоматической деактивации в account-service), окно «месяц» будет суммировать usage от старых периодов. ❓ Проверить: кто и когда переводит Package в `Inactive` в конце периода? Если никто — брать `min(periodStart, начало текущего месяца по tier)` или деактивировать.

### B2. `src/billing.ts`

- [x] **B2.1** ✅ исправлено 16.08: `Array.isArray(data) && data.length > 0` + 400 во всех push-хендлерах.
- [ ] **B2.2** 🟡 `billing.ts:402` `handleResetWorkspaceUsed` → `postgres.ts:1211` `resetWorkspaceUsed`: зерирует только `workspace_limit_state`. Каждый часовой цикл `refreshWorkspace → recompute` (limits.ts:214) пересчитывает `used` из таблицы usage и `upsertLimitState` — блок **восстанавливается через ≤1 часа**. Кнопка «reset» в admin UI вводит в заблуждение. Fix: вместе со state удалить строки `ai_tokens_usage` workspace за период (как делает `setWorkspaceUsed`), либо явно пометить reset как временный.
- [ ] **B2.3** 🟡 `billing.ts:419` `handleSetWorkspaceUsed` → `postgres.ts:1220` `setWorkspaceUsed`: админ-эндпоинт, но деструктивный — `DELETE` 30 дней реального usage + overwrite `limit_state.used`. Оставлен как «test helper» в проде. Fix: добавить в описание UI, что это стирает историю; опционально — только на dev-стендах (feature-flag/env).
- [ ] **B2.4** ❓ `billing.ts:550` `resolveWorkspacePlan`: при падении account-service fail-open на env-значения (`WindowMonthLimit`, период = 30 дней назад) — enforcement молча работает с чужим окном. Решено намеренно (комментарий есть), но нужно: метрика/алерт на фолбэк, чтобы выбить outage в логи не только warn.

### B3. `src/db/postgres.ts`

- [x] **B3.1** ✅ исправлено 16.08: после upsert удаляются записи, отсутствующие в entries; пустой массив — no-op (защита от сбоя конфига).
- [x] **B3.2** ✅ исправлено 16.08: поле переименовано в `usedRolling30d` + тултип в admin UI. Приведение к periodStart дало бы N+1 на breakdown.
- [ ] **B3.3** 🔵 `postgres.ts:1127` `updateProviderPoolState`: get-then-update не атомарно. Воркер один, но admin `upsertProviderPool` (сброс used=0) может concorrir с тиком recompute. Fix (опционально): атомарный `UPDATE ... SET used_tokens=$3, exhausted = ($3 >= purchased_tokens)` с расчётом crossed в SQL.
- [ ] **B3.4** 🔵 `postgres.ts:1308` `truncToHour` + `usage.ts:118`: бакеты usage по UTC-часу, pool periodStart «floor до часа» — пересчёт до 1 часа usage. Приемлемо, зафиксировать в комменте (уже есть) — можно зачесть как есть.

### B4. `src/db/migrations.ts`

- [ ] **B4.1** 🟡 V7: `DROP TABLE billing.ai_tokens_usage` — при деплое на стенд с историей все token-usage сгорают (в комменте «ephemeral»). ❓ Проверить, что на проде нет потребителей истории (admin-чарты за старый период, экспорт). Если есть — заменить на `ALTER + backfill`.
- [x] **B4.2** ✅ исправлено 16.08: V7-V9 сквошены в `ai_token_infra_v2_07`; стенды со старой цепочкой пересоздаются.

### B5. `src/usage.ts`, `src/notify.ts`, `src/pool.ts`

- [ ] **B5.1** 🟡 `notify.ts:38`: `producer.send(ctx, '' as WorkspaceUuid, [...], to)` — пустой workspace в NotificationQueue. Проверить, как mail-консьюмер использует workspace (если резолвит по нему workspace/plan — письмо не уйдёт).
- [x] **B5.2** ✅ исправлено 16.08: комментарий resetAt переписан (конец 30-дневного периода от periodStart).
- [ ] **B5.3** 🔵 `pool.ts` `computePoolTransition` — чисто и покрыт тестом (`__tests__/pool.spec.ts`). ОК.

### B6. прочее (config/main)

- [x] **B6.1** ✅ исправлено 16.08: `indexOf(':')` вместо `split`.
- [x] **B6.2** ✅ исправлено 16.08: guard `Array.isArray(value.entries)`, иначе drop + error (без throw, чтобы poison не зациклил консьюмер).
- [ ] **B6.3** 🔵 `main.ts` `getPlatformQueue('billing', config.QueueRegion)` — новый region-параметр; проверить, что `QUEUE_REGION` проброшен в docker-compose/деплой конфигах billing pod (иначе молча пустой region).

### billing-client (`packages/billing-client`)

- [x] **B6.4** ⏭️ опровергнуто 16.08: `addAiTokens` идёт через общий `fetchSafe` (client.ts:262-267), который кидает `BillingError` при `!response.ok`.
- [ ] **B6.5** 🔵 `types.ts` `LevelUsage.label` — в billing pod `getWorkspaceLevelUsage` всегда возвращает `label` (fallback к level), в клиенте опциональное — согласовать.

---

## Батч 2 — payment / account / core

### P1. `server/account` — workspace_purchase

- [x] **P1.1** ✅ исправлено 16.08: `activated_on = COALESCE($3, activated_on)`; aibot больше не шлёт `Date.now()` при `consumed`.
- [x] **P1.2** ✅ исправлено 16.08: миграции v39 (дедуп существующих строк) + v40 (partial unique index на (payment_id, provider) WHERE payment_id IS NOT NULL). Раздельно: cockroach не любит DDL+DML в одной транзакции.
- [x] **P1.3** ✅ проверено 16.08: aibot зовёт `updatePurchaseStatus` с токеном `{service:'ai-bot', admin:'true'}` (pod-ai-bot billing.ts:410) — проходит по `admin === 'true'` ветке (serviceOperations.ts:1963). Forbidden нет.

### P2. `services/payment/pod-payment`

- [x] **P2.1** ✅ исправлено 16.08: при дедуп-хите событие переопубликовывается, если покупка не `consumed`.
- [x] **P2.2** ✅ исправлено 16.08: ошибка отмены старого пакета прерывает операцию (relayProviderError + return), новый пакет не создаётся.
- [x] **P2.3** ✅ исправлено 16.08: `ctx.warn` при загрузке plan-config для платного плана без `windowMonthLimit`.
- [ ] **P2.4** 🔵 downgrade-гейты (`planTokenBudget`): сравнение только по token-бюджету. Страничный пакет (storage) имеет `tokenLimit: 0` — переход «AI package → storage package» проходит по разным category, ОК; но switch двух storage-пакетов (бюджет 0 == 0) не блокируется — корректно ли для storage-категории? ❓ Подтвердить, что гейт по бюджету не нужен для storage.
- [x] **P2.5** ✅ исправлено 16.08: в словарь `SERVICE.type` добавлен `purchase`.

---

## Батч 3 — ai-bot pod

### A1. `src/billing.ts`

- [x] **A1.1** ✅ исправлено 16.08: `reason` чистый, модель только в поле `model`.
- [x] **A1.2** ✅ исправлено 16.08: per-model детализация переведена на **platform queue** (новый kind `ai-tokens-detail`, консьюмер в pod-billing main.ts -> `db.pushAiTokensData`). Дельта и детализация уходят одним `send` с одним ключом партиции, так что детализация не обгонит дельту enforcement. Dual-write REST убран. REST-эндпоинт `/api/v1/ai/tokens` оставлен — им пользуется sanity-тест.
- [ ] **A1.3** 🔵 `pushTokensData` суммирует `data` по workspace'ам, но шлёт POST с `data[0].workspace` — неявное допущение single-workspace batch.
- [ ] **A1.4** 🟡 `getWorkspaceWindows` при недоступном billing pod и пустом кэше (например, после рестарта pod'а) → `unavailable`, isFree=false, всё блокируется. Намеренная «refuse without metering», но: нужен алерт на `unavailable` и решение, сколько обслуживать со stale-кэша (30s TTL — после рестарта кэша нет).

### A2. `src/pool.ts`

- [x] **A2.1** ✅ исправлено 16.08: `markExhausted` удалён.
- [x] **A2.2** ✅ исправлено 16.08: комментарий приведён к коду (старт не блокируется).
- [x] **A2.3** ✅ исправлено 16.08: параметр переименован в `rawTokens`.
- [ ] **A2.4** 🔵 provider-level pool (model ''): локальный self-track (`addUsage`) только model-level — exhaustion provider-пула в периоде не self-блокируется, только из fetch.

### A3. `src/queue.ts` (роли)

- [ ] **A3.1** 🟡 workspace consumer group `'ai-bot'` общая для всех ролей/pod'ов: LimitsChanged/Up/PurchaseActivated доставляются ровно одной инстанции. Ллm-router реплика, реально обслуживающая workspace, может событие LimitsChanged не получить → её 30s-кэш окон не инвалидируется, `limitsState` stale до следующего события. Fix: per-role consumer group на workspace-топик (или запуск workspace-консьюмера только в ролях, которым он нужен).
- [ ] **A3.2** 🟡 `startEventRouter`: producer не создан → `ctx.error` + return — событие тихо потеряно (нет DLQ).
- [ ] **A3.3** 🟡 llm-router consumer: error → `ctx.error` + ack — вся batch теряется, нет DLQ/retry.
- [ ] **A3.4** 🔵 stt chat-voice: `processChatVoice` без heartbeat-контроля; ошибка → только лог (нет DLQ) — долгая задача рискует сессией тайм-аута.
- [x] **A3.5** ✅ исправлено 16.08: ветка PurchaseActivated делает rethrow -> Kafka redeliver. Пометка `consumed` при этом обёрнута в try/catch (у package-гранта нет записи purchase, иначе вечный redeliver).
- [ ] **A3.6** 🔵 event-router на Up-событие вызывает `aiControl.connect(workspace)` — открывает server-client соединение в роли, которая запросы не обслуживает (зря).

### A4. `src/config.ts`

- [x] **A4.1** ✅ исправлено 16.08: заголовок = Hardcore 2024 + Intabia 2026.
- [x] **A4.2** ✅ исправлено 16.08: `console.warn` при legacy-блоке `stt:` в yaml.
- [ ] **A4.3** 🔵 fallbackEligible-guard бросает только когда отсутствуют ОБА мультипликатора — paid-level с `paidMultiplier` тоже может быть fallbackEligible. Ужесточить проверку.

### A5. `src/llms/toolLoop.ts`

- [ ] **A5.1** ❓ tool-вызовы в раунде идут параллельно (`Promise.all`) — проверить, что инструменты со side-effect (create/update doc)Concurrency-безопасны.
- [x] **A5.2** ⏭️ опровергнуто 16.08: реализации `execute` уже оборачивают вызов в try/catch и возвращают error-строку (gigachat.ts:216-223, llms/server.ts:255-262) — упавший tool не валит запрос.

---

## Батч 4 — UI (billing / admin)

### U. `plugins/billing-resources`, `plugins/admin-resources`

- [ ] **U1.1** 🟡 `WorkspacesTab.svelte::loadBillingUsage`: `getWorkspaceBreakdown(1000, 0)` — только топ-1000 по used_month; workspace'ы за 1000-м местом показывают 0 в колонке Tokens (неверные значения, не только сортировка). `getTranscriptUsage('workspace')` — глобальный запрос без пагинации: тяжёлый ответ при открытии admin-страницы на большом деплое. Fix: пагинация/limit по page или ленивая подгрузка по выбранной странице.
- [ ] **U1.2** 🔵 `asrMinutesByWs`: `it.workspace ?? ''` — строки с пустым workspace падают в мусорный бакет ''.
- [ ] **U1.3** 🔵 `AdminBilling.svelte` (billing-resources) и `BillingTab.svelte` (admin-resources) — дубли одной и той же вкладки. Унести в одно место.
- [ ] **U1.4** 🔵 `Subscriptions.svelte::buyPurchasable`: `chargeFor: () => Number(item.priceMonthly ?? 0)` — для разового SKU используется поле `priceMonthly` (см. C1.2 — misleading-имя).

---

## Батч 5 — tests / docs / config

- [x] **C1.1** ✅ исправлено 16.08: устаревший rolling 5h/week комментарий удалён.
- [ ] **C1.2** 🔵 `purchasables` используют `priceMonthly` для разовой цены — misleading. Переименовать поле (например, `price`) или явно задокументировать конвенцию.
- [x] **C1.3** ✅ проверено 16.08: `/_ai`/`/_aibot` только в dev/tests/ws-tests nginx.conf; прод-шаблон `pods/front/nginx.conf` их не содержит.
- [ ] **C1.4** 🔵 docker-compose (tests, ws-tests): aibot в `MODE=all` — role-сплит (event-router/llm-router) не покрыт тестами. Добавить CI-запуск со сплитом ролей.
- [ ] **C1.5** ❓ sanity `ai-bot.spec.ts` покрывает blocked-путь (limit → сообщение). ❓ Проверить, что покрыт downgrade-путь (paid → fallback basic level) и ASR-levels — если нет, дописать.
