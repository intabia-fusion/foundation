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
`SERVER_SECRET`, `FRONT_URL`, `BACKUP_TEST_WS` (default `api-tests`).

Not part of `_phase:test` -- these need the full environment, so CI must run
`backup-test` explicitly.
