# Fulltext pod - bulk mode analysis & fix

## TL;DR

- **Producer**: bulk send корректный. `PlatformQueueProducer.send(ctx, ws, msgs[])` принимает массив; в Kafka SDK (`foundations/server/packages/kafka/src/index.ts`) это один `kafkajs.producer.send` с массивом `messages` и `CompressionTypes.GZIP`.
- **Consumer (был)**: `PlatformQueueBatchConsumerImpl` использовал `cc.run({ eachMessage })` + accumulator. Это **не работает по дизайну kafkajs**: `eachMessage` per-partition serial, следующее сообщение не вызывается пока предыдущий promise не зарезолвлен. Аккумуляция упирается в `batchTimeout` (по умолчанию 100ms на каждое сообщение). Реальный throughput оставался per-message + 100ms latency.
- **Consumer (сейчас)**: переписано на нативный `cc.run({ eachBatch, eachBatchAutoResolve: false })`. Kafkajs отдаёт реальный батч из broker fetch, нарезаем на чанки `batchSize`, `resolveOffset` после успешной обработки чанка. `batchTimeout` теперь корректно мапится в `maxWaitTimeInMs`.
- **Indexer**: `FullTextIndexPipeline.processTransactions` (`server/indexer/src/indexer/indexer.ts:709`) уже принимал массив и группировал по `objectClass` — batch-friendly изначально, только manager его не использовал.

## Что изменили

1. **`foundations/server/packages/kafka/src/index.ts`** — переписан `PlatformQueueBatchConsumerImpl.start()` с `eachMessage` accumulator на `eachBatch`. Также `createBatchConsumer` теперь полезен для `services/love` и `services/ai-bot` (они тоже звали его, тоже страдали).
2. **`pods/fulltext/src/manager.ts:140`** — `txConsumer` через `createBatchConsumer({ batchSize: 100, batchTimeout: 100 })`. ENV override: `FULLTEXT_TX_BATCH_SIZE`, `FULLTEXT_TX_BATCH_TIMEOUT`.
3. **`processTransactions`** теперь принимает `ConsumerMessage[]`, группирует по `m.workspace`, передаёт values массивом в `indexer.fulltext.processTransactions`. DLQ тоже теперь батчевый.

## Числа (bench на dev стенде, redpanda+pg+cockroach+elastic)

| scenario | до (eachMessage) | после (eachBatch) | x |
|----------|------------------|-------------------|---|
| producer batch=1, 200 docs | 144 docs/s | **2062 docs/s** | 14x |
| producer batch=50, 200 docs | 186 docs/s | **5714 docs/s** | 31x |
| producer batch=1000, 1000 docs | 217 docs/s | **6494 docs/s** | 30x |
| pipeline e2e, 200 createDoc | 175 docs/s | **503 docs/s** | 3x |

Pipeline e2e ограничен скоростью write-side (`TxOperations.createDoc` синхронный). Индексация перестала быть бутылочным горлом.

## Корректность

- kafka SDK `__test__/queue.spec.ts`: 8/8 PASS (включая 3 batch-теста)
- fulltext `__tests__/indexing.spec.ts`: 3/3 PASS
- fulltext `__tests__/indexing.bench.ts`: 4/4 PASS

## Прочие consumer

`workspaceConsumer`/`fulltextConsumer` (`manager.ts:121,130`) оставлены на `createConsumer` (per-message) — события редкие и stateful (full reindex, drop), батчинг там не нужен.

## Запуск тестов

Окружение через `tests/prepare-tests.sh` (docker-compose: redpanda 19093, cockroach 26258, postgres 5433, elastic 9201). Локальный run: `cd pods/fulltext && pnpm run test` (включая bench, по совпадению с `*.bench.ts` в jest config).
