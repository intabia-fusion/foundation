# CockroachDB dropped from the test lane (possible, not supported for now)

Decision (2026-09-08): the unit test phase runs against pure PostgreSQL only. CockroachDB stays a
*possible* backend — the adapter code and the cockroach stand are untouched — but nothing verifies
it, so treat it as dropped until someone re-enables it.

## What ran on cockroach before

The unit lane pointed `DB_URL` at cockroach on 26258 and `tests/prepare-tests.sh` started the
container and migrated it. Four places depended on that:

- `@hcengineering/postgres` — `integration.test.ts` / `storage.test.ts`, `DB_URL` default
- `pods/fulltext` — `src/__tests__/utils.ts`, url was a hardcoded constant, no env override
- `pod-telegram-bot` — `postgres-real.test.ts` ran both flavors side by side and compared them

## What changed

- All three now default to `postgresql://postgres:postgres@localhost:5433/postgres`, overridable
  through `DB_URL`. `POSTGRES_URL` is gone — only the telegram test used it, and it now needs one url.
- `postgres-real.test.ts` lost its cockroach half: 16 tests -> 10. The cockroach-only cases
  (`unique_rowid()` defaults vs `GENERATED ALWAYS AS IDENTITY`) went with it; that is the coverage
  the decision gives up.
- `tests/prepare-tests.sh` no longer starts cockroach or migrates it.
- CI `test` job env: `DB_URL` points at postgres, `POSTGRES_URL` removed.

Untouched and still cockroach: `tests/prepare-cockroach.sh`, `tests/docker-compose.cockroach.yaml`,
`tests/tool-cockroach.sh`, the `uitest-cockroach` job (already gated behind the `run-cockroach`
dispatch input, default false), and `foundations/server/tests/`.

## Speed

`@hcengineering/postgres` went 57.3s -> 10.5s, `pod-telegram-bot` 7.6s -> 0.8s. `pod-fulltext` is
unchanged at ~22s because it waits on kafka, not the database.

## Two bugs this uncovered

`baseDbUri.replace('defaultdb', dbUuid)` built the per-test database URI. A pg URL has no
`defaultdb` segment, so the replace silently returned the base URI and every test shared one
database while `CREATE DATABASE` still created an orphan per test. Replaced with `withDatabase()`
in `__tests__/utils.ts`, which rewrites the URI path.

`integration.test.ts` dropped its database with `DROP DATABASE ... CASCADE` — cockroach syntax that
postgres rejects, swallowed by the surrounding try/catch. `CASCADE` removed.

Still open: `storage.test.ts` leaks a database per test. Its `afterEach` calls
`serverStorage?.close()`, but `initDb` declares `const serverStorage` locally and shadows the outer
variable, so nothing is ever closed and `DROP DATABASE` cannot run — every attempt hits "database is
being accessed by other users" and each test stalls ~5s. Left as is; fixing it means untangling the
shadowed variable first.
