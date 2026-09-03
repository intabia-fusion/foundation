# Pod log volume: what was actually filling it

A sanity run left these line counts, with **zero errors** in the two biggest:

| pod | lines | what most of it was |
|---|---|---|
| front0 | 45822 | 45600 morgan access lines, one per static asset request |
| workspace | 9420 | 84% in five messages, all reporting success |
| transactor0 | 13464 | a workflow trigger logging every update tx, and again when it did nothing |
| fulltext | 11928 | 88% a `reindex verify` / `reindex done` pair, at **warn** level |

## The measurement that decided the threshold

The per-operation logs in `server/tool/src/index.ts` were gated on `tdelta > 0`, which is true for
essentially everything. Pulling the timings out of the logs:

| message | n | p50 | p95 | max |
|---|---|---|---|---|
| `Create` | 4231 | 0.02 ms | 51 ms | 372 ms |
| `migrate:` | 3991 | 0.02 ms | 6 ms | 50 ms |
| `pre-migrate:` | 404 | 1.8 ms | 10 ms | 79 ms |

Eight thousand lines describing work measured in hundredths of a millisecond. `SLOW_OP_MS = 250`
prints nothing on a healthy run and still surfaces an operation worth looking at.

## Policy applied

Only failures are logged unconditionally. Success gets a line when it was slow enough to matter,
or when it actually changed something (`reindex done` only when `processed > 0`). Conditions that
belong to the deployment rather than the workspace are reported once per process, not per
workspace (`PlanLimitsBootMiddleware`).

## Where the knobs are

- `SLOW_OP_MS` - `server/tool/src/index.ts`
- `SLOW_MIGRATION_MS` - `foundations/core/packages/model/src/migration.ts`
- `ACCESS_LOG=all` - restores the full front access log

## What this costs

The pre-migration log in `migration.ts` used to name the migration before running it, which was
the only breadcrumb if one **hung** rather than threw. It now reports after the fact, so a hang
shows up as a missing `---CREATE-DONE---` instead. The `catch` beside it already names the plugin
and state on failure, so nothing is lost when a migration actually fails.

## Left alone deliberately

- `no document found, failed to apply model transaction, skipping` (`memdb.ts:344`) - a model
  `TxUpdateDoc` against a document that is not there. Either a real model divergence or an
  expected race; silencing it without understanding it would hide a defect.
- `TxApplyIf failed` - same reasoning.
