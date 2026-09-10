# Kafka consumer lifecycle dominates fulltext test time

`pod-fulltext` was the slowest test package on CI (150.5s of a 584s test phase). None of it was
the tests: measured on a local stand, useful work was 1.8s (batch-removal) and 3.0s (indexing).

Per-test cost of building a fresh harness was 17.3s:

```
createTopics        2502ms
startIndexer          49ms
waitConsumersReady  5030ms
withIndexer          106ms
shutdown            9703ms
```

Inside `shutdown`: `txConsumer` 13ms, `workspaceConsumer` 4660ms, `fulltextConsumer` 5002ms.

Root cause: the batch consumer gets an explicit `maxWaitTimeInMs` (`FULLTEXT_TX_BATCH_TIMEOUT`,
default 100), the two plain consumers get none — kafkajs then defaults to **5000ms**.
`consumer.disconnect()` waits out the in-flight fetch long-poll, and `manager.shutdown` closed the
three sequentially. The same 5s shows up in `waitConsumersReady`: `firstFetchDone` resolves on the
first FETCH event, which on an empty topic returns only after `maxWaitTimeInMs`.

Fixes (`3248eef701`):
- `manager.shutdown` closes the three consumers via `Promise.all` (also speeds up pod shutdown).
- Both spec files build one harness in `beforeAll` instead of one per test. Tests were already
  isolated by a random workspace uuid per test, so nothing else had to change.

Result: 138.3s -> 23.5s locally, 10/10 green. What is left is one harness lifecycle per file
(~14s and ~20s); cutting it further means lowering `maxWaitTimeInMs` on the plain consumers, which
trades broker fetch frequency for it — not done.

Same shape is worth checking in other kafka-dependent suites (`@hcengineering/kafka` was 23.2s).
