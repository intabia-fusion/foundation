# Workspace wakeup queue + pending-delete (FUSIO-1115)

- Root cause залипания pending-deletion: updateWorkspaceInfo не имел case delete-started/delete-done,
  mode не двигался, processing_attempts рос > 3 - строка навсегда выпадала из getPendingWorkspace.
  Также user deleteWorkspace не сбрасывал attempts. Разлиплять: reset-attempts.
- Deletion обрабатывает только WS_OPERATION=all+backup (дефолт 'all' - нет).
- Wakeup: account шлёт QueueTopic.WorkspaceWakeup в регион пространства при любой новой pending-работе
  (включая визит в спящее по WsLivenessDays пространство); воркеры - consumer со своим groupId на под
  (broadcast), будят doSleep. Backoff: WAIT_TIMEOUT 5с, после 30с без активности x2 до WAIT_MAX_TIMEOUT
  (60с). Поллинг остаётся backstop: upgrade находится только сравнением версии ВОРКЕРА в SQL.
- Регионы: kafka одна, топик = `${region}.<topic><postfix>`. Один PlatformQueue с опциональным
  регионом: getProducer(ctx, topic, region?) - не передали, берётся регион инстанса (env);
  createConsumer/createBatchConsumer - options.regions: string[] (один consumer на топик всех
  перечисленных регионов, groupId тогда `${groupId}${postfix}`, без regions - историческая схема
  `${topicId}-${groupId}`); createTopic(topics, partitions, regions?). Продюсеры кешируются по
  разрешённому имени топика. Account: домашняя
  очередь для mail/crm/payment-ledger + CrossRegionQueue (metadata RegionalQueue) для
  workspace/fulltext/online-user-tx/wakeup в регион workspace. НЕ делать очередь account целиком
  region-less - staging весь на pg.*.
- Presence: юзер может быть online в пространствах разных регионов - send per workspace в его регион.
- Multi-topic consumer: один kafkajs Consumer на список топиков (замер: 4 консюмера = 8 сокетов/
  4 группы, 1 multi-topic = 2/1). CrossRegionQueue groupId = `${groupId}${postfix}`, одиночный топик
  PlatformQueue - историческая схема `${topicId}-${groupId}` (оффсеты). Используют account users и
  payment workspace (регионы через getRegionInfo).
- Consumer, подписанный на несуществующий топик, НЕ подхватит его после создания (kafkajs, проверено
  пробой при auto_create=false). Фикс: waitForTopics в обоих consumer-имплах kafka - перед
  connect/subscribe поллит admin.listTopics с backoff 100ms x2 до 5с, пока все топики не появятся
  (close() прерывает через флаг stopped). createTopic перед подпиской больше не обязателен, но полезен.
- kafkajs 2.2.4 = последний стабильный, проект мёртв с 2023; альтернатива @confluentinc/kafka-javascript
  (задача заведена). Regex-подписка kafkajs статична (разворачивается при subscribe) - динамики не даёт.
- TimeoutNegativeWarning (-Date.now()) в логах любого пода с kafkajs: RequestQueue.
  scheduleCheckPendingRequests делает setTimeout(throttledUntil - Date.now()) при throttledUntil=-1.
  Безвредно (Node clamp в 1мс), уйдёт с миграцией на confluent.
- Юнит-тесты сна: server/workspace-service/src/__tests__/backoff.test.ts - backoff (4) + main loop
  start() c мокнутым getPendingWorkspace: спит без работы, wakeup() будит немедленно, поллинг-backstop (3).
- Классификация сервисов по регионам: docs/region-services.md.
- e2e: ws-tests/sanity/tests/workspace/delete.spec.ts (admin delete + owner delete из settings,
  ждут mode 'deleted' через admin UI) и account-delete.spec.ts (admin удаляет аккаунт без workspace -
  sole-owner аккаунт удалить нельзя; логин после - wrong-credentials). С wakeup deletion ~8с.
