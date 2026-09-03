# Account DB migrations

## Adding a column and using it must be two migrations

CockroachDB parses a multi-statement batch as a whole before executing it. A migration like

```sql
ALTER TABLE person ADD COLUMN IF NOT EXISTS phone_hint TEXT;
UPDATE person p SET phone_hint = ... WHERE p.phone_hint IS NULL;
```

fails on cockroach with `42703 - column "p.phone_hint" does not exist`. PostgreSQL executes the
statements sequentially and swallows it, so the bug only appears on the cockroach regions.

Symptom seen in the wild (FUSIO-1121, v35): `sanity-workspace-1` looped on the error for hours and
stopped processing the queue entirely - every workspace creation hung at "Creation in progress... 0 %".
Nothing in the UI pointed at migrations; `docker logs sanity-workspace-1` did.

Split it: `v35` = `ADD COLUMN`, `v36` = backfill. Same reason `v33` was split off from `v32`
(cockroach also refuses an index build while a freshly added column is still backfilling).

Check both flavors when a migration touches schema:

```bash
docker exec sanity-postgres-1 psql -U postgres -p 5433 -d postgres \
  -c "SELECT identifier, applied_at IS NOT NULL FROM global_account._account_applied_migrations ORDER BY identifier;"
docker exec sanity-cockroach-1 ./cockroach sql --insecure -d defaultdb \
  -e "SELECT identifier, applied_at IS NOT NULL FROM global_account._account_applied_migrations;"
```

On the ws-tests stand account uses postgres (`DB_PG_URL`) while the default-region workspace pod uses
cockroach (`DB_URL`) - a migration can be applied in one and missing in the other.

## Never edit an applied migration

`postgres.ts` warns `Migration <id> was applied with different DDL than the current build defines`
when the stored DDL differs. It is only a warning, the migration never re-runs. On a stand that ran
an intermediate build, delete the row so it re-applies (safe only while the DDL is idempotent):

```sql
DELETE FROM global_account._account_applied_migrations WHERE identifier = '<id>';
```
