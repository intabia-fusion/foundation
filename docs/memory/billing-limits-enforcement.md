# Billing limits enforcement (FUSIO-740)

Состояние после коммита 277d851f4e.

## Багфиксы при тестировании (2026-06-10)

- **contextVars был общим объектом на все workspace-pipelines** (`server-pipeline/pipeline.ts:213`) — PLAN_LIMITS_VAR/spaceCounts перетирались между workspace. Фикс: shallow copy per pipeline. Любое per-workspace состояние в contextVars до этого фикса было кросс-workspace багом.
- PlanLimits перемещён ПЕРЕД SpaceSecurity: иначе off-by-one (создаваемый space уже в counts) + фантомы при reject.
- Chain строится снизу вверх (`buildChain` index--): middleware выше по списку создаётся ПОЗЖЕ. SeatLimits -> lazy initSeats (PLAN_LIMITS_VAR ещё не опубликован при его create).
- Cold-start: PlanLimits boot probe-findAll через next триггерит SpaceSecurity.init -> publish counts (findAll:711 вызывает init до обращения к account:716; probe в try/catch).
- System-created spaces (Records, Screen Recordings — builtin drives!) не считаются в лимит (`SpaceInfo.systemCreated`, `createdBy === core.account.System`); system-аккаунт bypass в PlanLimits.
- `adminCreateSubscription`: FK на account — tool-токен (system) не в таблице account, fallback на owner workspace.
- REST api-client `withRetry` ретраит Forbidden ~5 раз — в логах transactor каждый отказ x6.

## CLI / тестовые стенды

- `dev/tool set-workspace-plan <ws> <plan> [--projects N ...]` (0=безлимит), `show-workspace-plan`.
- Стенды: sanity-ws/meetings-ws/api-tests* -> business (всё 0); limits-ws (tests/) и api-tests-limits (ws-tests/) -> start --projects 1 --drives 1 --teamspaces 1.
- api-тест: `ws-tests/api-tests/src/__tests__/plan-limits.test.ts` (счёт через system-клиент с фильтром `createdBy $ne System`); playwright: `tests/sanity/tests/limits/plan-limits.spec.ts`.

## Payment publisher + runtime refresh (сделано 2026-06-11)

Бывший главный gap закрыт:
- account-service — единая точка записи подписки: `upsertSubscription`/`adminCreateSubscription` публикуют edge-triggered `LimitsChanged{payment}` (bad = past_due|canceled|expired) и `LimitsChanged{plan}` (plan/limits изменились) в QueueTopic.Workspace. Producer через `accountPlugin.metadata.WorkspaceQueue`.
- Новая категория `'plan'` в LimitCategory; pods/server консьюмер перечитывает `getPlanLimits` в shared `planLimitsMap` (`PLAN_LIMITS_MAP_KEY`); PlanLimits/SeatLimits читают live из map; SeatLimits пересобирает seat-set при смене usersLimit.
- Billing `syncPaymentStatus` в startup scan — recovery потерянных payment-событий.
- Тесты: plan-limits "upgrade lifts limit without restart" + plan-unpaid.test.ts (ws `api-tests-unpaid` без плана в prepare.sh, upsert payment-токеном; константный providerSubscriptionId против накопления подписок). 53/53 x2.
- Грабля: `create-workspace` НЕ даёт членства — нужен явный `assign-workspace` (+`set-user-role` для OWNER), иначе selectWorkspace -> Forbidden.

## Неочевидные решения

- effectiveRole: spread в новый contextData (`{...ctx.contextData, account: {...account, role}}`) — `account` shared Session reference, мутировать нельзя.
- `PRIVILEGED_ROLES` в SeatLimitsMiddleware = Owner+Maintainer+Admin, но `checkPrivilegedSeatLimit` (server/account/src/utils.ts) проверяет только Owner+Maintainer — Admin-повышение не блокируется (несогласованность).
- Storage used = абсолютный скан datalake (`collectDatalakeStats`); usage-дельты только триггер пересчёта + дедуп (`billing.usage_delta_dedup`, ref=sha256).
- aibot ref НЕ идемпотентен: tokens `uuid()`, transcript `Date.now()` — Kafka-ретрай задваивает used.
- Consumer groups: datalake/transactor per-instance (`getClientId()`), aibot shared `'ai-bot'` single-instance.
- payment cold-start fail-open осознанно (account недоступен -> write разрешён).
- `transcriptLimit = meetingMinutesLimit * 60` (отдельного поля нет, отложено).
- Seat cooldown откинут: seat освобождается только при kick (`employee.active=false`).
- Pipeline-порядок: SeatLimits -> GuestPermissions -> PlanLimits; spaceCounts отражает состояние ДО tx.

## 2026-06-12: приоритетная seat-модель + добивка

- Seat-модель переделана: seat-set = первые N active employee по `(rolePriority, createdOn)` (Owner=0, Maintainer=1, User=2). Привилегированные занимают места первыми, БЕЗ write-bypass и БЕЗ вычитания из бюджета (оплата - внешний флоу, Owner'у достаточно чтения). Owner сверх N - read-only. `checkPrivilegedSeatLimit` удалён.
- aibot ref теперь идемпотентен где возможно: OpenAI `response.id` (7 sites), transcript `task.blobId`; GigaChat/aggregate-tools - fallback uuid (id нет).
- aibot LLM-отказ: `ApiError(402)` вместо Error->500; лимит добавлен в `translate()`/`summarizeMessages()` (не проверялся вовсе).
- datalake multipart complete: 413-блок + storage-delta (`ref=metadata.etag`).
- `PlanLimitExceeded` ловится в `ReadOnlyAccessMiddleware` (view-resources) -> notification; intl в platform lang + view-assets.
- Точный isLimited: клиентская репликация seat-set в `checkIsLimited()`; aibot исключён через `aiBotEmailSocialKey` -> SocialIdentity; `getWorkspaceMembers` доступен любому члену workspace.
- REST usage-приём pod-billing ОСТАВЛЕН: живые потребители translate-сервис и Deepgram cost-tracking (отдельная природа данных - затраты, не лимиты).

## 2026-08-17: join-по-инвайту маскировался под "invalid otp"

Симптом: новый юзер по инвайт-ссылке видит "invalid otp" на каждом заходе. В логах account: OTP валиден ("OTP login/verification success"), падает `joinByInvite` -> `PlanLimitExceeded` (`assertSeatAvailableOnJoin`, server/account/src/utils.ts). Единственный настоящий `InvalidOtp` - повторная отправка уже потраченного кода (signup сжигает OTP, юзер жмёт ещё раз).

Причина маскировки: `joinByInvite` в plugins/login-resources/src/utils.ts глотал `PlatformError` и возвращал `undefined`; Join.svelte показывал generic `JoinWorkspaceError`. Исправлено: возвращает `[Status, WorkspaceLoginInfo | undefined]`, Join.svelte рендерит реальный статус (у `PlanLimitExceeded` есть intl во всех lang-файлах platform).
