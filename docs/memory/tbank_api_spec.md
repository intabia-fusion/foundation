# T-Bank Acquiring API — spec для собственной реализации (замена tbank-payments)

Источник истины: официальная документация T-Bank https://developer.tbank.ru/eacq/api/ (July 2026).
Clean-room реализация под EPL-2.0 (не порт MIT-либы). Библиотека `tbank-payments@1.2.1` НЕ используется как источник кода.

## Контекст
pod `services/payment/pod-tbank-subscriptions` использует `tbank-payments` только для 5 методов.
Решено: реализовать свой модуль `src/tbank.ts` на native fetch (Node 20+), без axios/axios-retry/joi.
Реализуем 7 методов (5 used + getPaymentState/checkOrder для перепроверки).

## Base URL
Prod: `https://securepay.tinkoff.ru`, все endpoint под `/v2/*`. POST, JSON.

## Token (подпись) — критично 1:1 с банком
1. Взять корневые поля запроса, исключить: вложенные объекты/массивы, `Token`, поля со значением undefined.
2. Добавить `Password` = secret (terminal password).
3. Отсортировать ключи по алфавиту.
4. Конкатенировать значения (без разделителей).
5. SHA-256, hex lowercase.
Верифицировано с dev-портала + независимыми клиентами. boolean сериализуется как "true"/"false".

## verifyNotificationSignature
Тот же алгоритм: собрать поля вебхука (кроме Token), + Password, sort, concat, sha256; сравнить с присланным Token.
verifyNotificationSignatureRaw(rawBody, token) — опциональный, pod fallback'ится если нет (utils.ts:71).

## Единый error-контракт (по решению пользователя)
- Сеть/timeout/5xx после исчерпания retry -> **throw** (transport error, помечать флагом для pod).
- HTTP 200 + `Success:false` -> **вернуть объект** {Success:false, ErrorCode, Message, Details, Status}. НЕ кидать.
- Никогда не кидать на бизнес-fail (card decline).
BaseResponse (все endpoint): TerminalKey, Success(bool), ErrorCode(string), Message(string, opt), Details(string, opt).

## Retry
Как lib: 3 попытки, exp backoff, только на сеть + 5xx. timeout 30s. Идемпотентность GET-подобных не важна тут.

## Endpoints

### POST /v2/Init  (initPayment)
Request required: TerminalKey, Amount(kopecks, ≤10 знаков), OrderId(≤50), Token.
Request optional: Description(≤140, карта ≤250), CustomerKey(≤255, обязателен при Recurrent=Y),
  Recurrent('Y'), PayType('O'|'T'), Language('ru'|'en'), OperationInitiatorType('0'|'1'|'2'|'R'|'I'|'D'|'N'),
  RedirectDueDate(YYYY-MM-DDTHH:MM:SS+GMT, 1мин..90дней), NotificationURL, SuccessURL, FailURL,
  Receipt(object), DATA(object, ≤20 пар, key≤20 val≤100).
Response: Success, ErrorCode, TerminalKey, Status, PaymentId(number), OrderId, Amount, PaymentURL(uri), RebillId, Message, Details.

### POST /v2/Charge  (chargeRecurrent) — безакцептное списание
Request required: TerminalKey, PaymentId(≤20), RebillId, Token.
Request optional: IP, SendEmail(bool), InfoEmail(обязателен при SendEmail=true).
Response: Success, ErrorCode, TerminalKey, Status, PaymentId, OrderId, Amount, Message, Details.
Success-status: CONFIRMED (одностадийный). Fail -> Success:false + ErrorCode.

### POST /v2/Cancel  (cancelPayment) — отмена/возврат
Request required: TerminalKey, PaymentId, Token.
Request optional: Amount(kopecks, частичный возврат), IP, Receipt(object), ClientInfo(object),
  ExternalRequestId(≤255), QrMemberId(SBP), Route('TCB'|'BNPL'), Source('installment'|'BNPL').
ExternalRequestId = ключ идемпотентности: при повторном Cancel с тем же ID банк вернёт состояние прежней
операции вместо второго возврата. Проставляем `cancel:${paymentId}` в cancelPendingCheckout (server.ts)
— защита от двойного возврата при retry (orphan-takeover/forced-switch).
Response: Success, PaymentId, OrderId, Status, OriginalAmount, NewAmount, ErrorCode, Message, Details.
Status: CANCELED (полная), REVERSED, PARTIAL_REVERSED, REFUNDED.

### POST /v2/RemoveCard  (removeCard)
Request required: TerminalKey, CustomerKey(≤36), CardId(≤40), Token.
Request optional: IP(≤40).
Response: Success, CustomerKey, CardId, ErrorCode, Message, Details.

### POST /v2/GetState  (getPaymentState) — перепроверка платежа по PaymentId
Request required: TerminalKey, PaymentId(≤20), Token.
Request optional: IP, GetPhone(bool).
Response: Success, PaymentId, OrderId, Status, Amount, ErrorCode, Message, Details, RebillId, CardId.

### POST /v2/CheckOrder  (checkOrder) — перепроверка по OrderId
Request required: TerminalKey, OrderId, Token.
Response: Success, OrderId, Payments[]{PaymentId, Status, Amount, ...}, ErrorCode, Message, Details.

## Полный набор Status платежа (GetState)
NEW, FORM_SHOWED, AUTHORIZING, AUTHORIZED, CONFIRMING, CONFIRMED, REVERSING, REVERSED,
REFUNDING, PARTIAL_REFUNDED, REFUNDED, REJECTED, DEADLINE_EXPIRED, CANCELED, 3DS_CHECKING, 3DS_CHECKED.
Дошёл: CONFIRMED, AUTHORIZED. Не дошёл: REJECTED, DEADLINE_EXPIRED, CANCELED. В процессе: NEW/FORM_SHOWED/*ING.

## Входящая очередь вебхуков (безопасность + надёжность)
Новый топик QueueTopic.TbankWebhook='tbank-webhook' (core/queue/types.ts), message QueueTbankWebhookMessage
(core/queue/tbankWebhook.ts): {notification, verified, receivedAt}.
- HTTP handleWebhook (тонкий): parse -> verify подписи (security-барьер, мусор не входит в очередь) ->
  enqueueWebhook -> 200. Enqueue-fail -> 500 (банк перешлёт, at-least-once, не теряем).
- Consumer (main.ts, createConsumer single-message, groupId 'tbank-webhook-processor'): вызывает
  processWebhook. throw -> ЛОКАЛЬНЫЙ retry того же msg навсегда (kafka wrapper НЕ делает broker
  redelivery). Poison-guard: TypeError/RangeError/SyntaxError -> log+return (не throw, иначе застрянет
  партиция); прочее -> throw (retriable transient). Batch убран (не нужен, per-msg offset проще).
- Идемпотентность REJECTED/REVERSED/REFUNDED (server.ts): guard alreadyApplied (sub PastDue +
  providerData.status===Status + !pending) -> skip upsert+notify; releaseCheckout остаётся (idempotent).
  Иначе повторная доставка сбрасывала retryAfter/дублировала notify.
- processWebhook (экспорт из server.ts): GetState-recheck (на актуальном состоянии) + вся apply-логика.
  Idempotency guard по PaymentId уже был (appliedPaymentId).
- Партиция по PaymentId (send 4-й арг partitionKey) — упорядочивание вебхуков одного платежа.
- createTopic на старте (idempotent, auto-create в брокере ВЫКЛ) — pod владеет топиком, 10 партиций.
Тесты webhook.test.ts переписаны: HTTP-ingress (verify+enqueue) отдельно от processWebhook (apply). 58/58 PASS.
Паттерн повторяет stripe/polar (verify -> enqueue -> 200, обработка в consumer).

## Изменения pod-логики (по решению пользователя — полная интеграция перепроверки)
1. utils.ts chargeSubscriptionRecurrent — проверять initResult.Success явно перед Charge
   (раньше полагались на throw либы; теперь Init на Success:false возвращает объект).
2. scheduler.ts catch (transport error) — вызвать getPaymentState/checkOrder чтобы узнать реальный
   исход платежа вместо слепого lease-takeover. charged/failed решать по Status.
3. webhook handler (server.ts/utils.ts) — после верификации подписи доп. перепроверять статус через
   getPaymentState (защита от потерянного/подделанного вебхука) — по решению пользователя.

## Статус: РЕАЛИЗОВАНО
- `src/tbank.ts` — класс TbankPayments (default export), native fetch, 0 deps. 7 методов + generateToken + verifyNotificationSignature.
  Экспорты: TbankTransportError (флаг transport для recheck), TBANK_SUCCESS_STATES, TBANK_FAILED_STATES.
  Error-контракт: Success:false -> объект; сеть/5xx после retry -> throw TbankTransportError.
- Импорты в main/mockTbank/scheduler/server/utils переключены 'tbank-payments' -> './tbank'.
- package.json: убран tbank-payments (axios/axios-retry/joi были транзитивными, в pod deps их не было).
- utils.ts: chargeSubscriptionRecurrent проверяет initResult.Success перед Charge; добавлен recheckChargeOutcome (CheckOrder-based).
- scheduler.ts catch: при transport-error вызывает recheckChargeOutcome -> charged/failed/unknown, решает исход точно.
- server.ts handleWebhook: CONFIRMED/AUTHORIZED вебхуки перепроверяются через getPaymentState (защита от потери/подделки); skip в dev/mock.
- mockTbank.ts: добавлены getPaymentState/checkOrder.
Build+validate чистые. 55/55 тестов PASS.
Гейча: тесты utils/updatePlan падали из-за устаревшего собранного @hcengineering/account-client (makePlanKey undefined) —
не связано с заменой; лечится `pnpm build:lint --to @hcengineering/account-client`.

> Полная карта статусов и переходов — `docs/billing-subscription-status-transitions.md`.
> При правке логики отмены обновлять оба файла в одном PR.

## Cancel semantics (FUSIO-1099, 2026-07-30)
`handleCancelSubscription` — что отменяемо:
- Canceled/Expired → идемпотентный 200 с текущим sub, без записи.
- PastDue/ReadOnly → отменяемы (нужно для downgrade на free после неудачного платежа/возврата).
- 400 только для pending first-payment draft (`isPendingFirstPayment`) — его закрывают вебхук/планировщик.

Куда ведёт отмена — две ветки `buildCanceledSubscriptionData`:
- **Оплаченная (Active)** → scheduled-cancel: остаётся Active, `willCancelAt = periodEnd`,
  `providerData.status='SCHEDULED_CANCEL'`, карта сохраняется (возможен uncancel). Финализирует
  планировщик в `willCancelAt`.
- **Неоплаченная (`isImmediateCancel` = PastDue || ReadOnly) и PLAN_CHANGE** → немедленно:
  `status: Canceled`, `canceledAt: now`, `willCancelAt: undefined`, карта снимается тут же
  (планировщик эту строку больше не увидит), `retryAttempt`/`retryAfter`/`pending` удаляются.

**`providerData.status = 'CANCELED'` — load-bearing.** `isFinalizedUserCancel`
(`pod-payment/src/utils.ts:44-50`) требует **пару** `(status=Canceled, providerData.status='CANCELED')`,
и только по ней `pod-payment` создаёт реальную free-подписку (`createFreeIfNoActiveTier`, main.ts:163).
`SCHEDULED_CANCEL`/`ABANDONED`/`REPLACED`/`PLAN_CHANGE` намеренно НЕ триггерят free.

Dunning email («не удалось списать») — только на REJECTED. REVERSED/REFUNDED = возврат средств
(support/admin), письмо клиенту не шлём.
