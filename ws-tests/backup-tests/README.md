# backup-tests

Backup/restore tests against a live stand. They go through the server-side
backup pipeline (same path `pods/backup` uses), not through a client API.

## Run

Bring the stand up first:

```
cd ws-tests
./prepare.sh
```

Then, from this directory:

```
pnpm run backup-test
```

Defaults target the local stand, so no exports are needed. Note the stand keeps
workspace data and the account DB on different servers: `DB_URL` points at
cockroach (26258), `ACCOUNT_DB_URL` at pure postgres (5433).

Overridable: `DB_URL`, `ACCOUNT_DB_URL`, `ACCOUNTS_URL`, `STORAGE_CONFIG`,
`SERVER_SECRET`, `FRONT_URL`, `BACKUP_TEST_WS` (default `api-tests`),
`BACKUP_STORAGE_CONFIG`, `BACKUP_BUCKET_NAME`.

## Suites

- `backup-incremental` -- backup/restore through the server-side pipeline.
- `backup-retention` -- archives of deleted workspaces. The grace period is configured in days, so
  the tests move `last_processing_time` back in the account DB rather than waiting; they call the
  cleanup directly and need no running pod.
- `backup-service` -- the `backup` pod itself: it must pick a freshly created workspace up on its
  own within a few minutes. Needs the pod up (it is part of `docker-compose.yaml`).

The archive bucket lives in minio, published on `localhost:9002` for these tests.

Not part of `_phase:test` -- these need the full environment, so CI must run
`backup-test` explicitly.
