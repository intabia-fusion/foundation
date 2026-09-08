# Testing

[← README](../README.md)

## Unit tests

```bash
pnpm test          # All tests, from the repository root
pnpm run test      # A single package, from inside its directory
pnpm test --to @hcengineering/core   # Scope to a package and its dependencies
```

Jest is configured at the root (`jest.config.js`); `pnpm jest` runs the shared runner
directly.

## UI tests (Playwright)

UI tests run against a full Docker stand, not against sources - build the images first.

```bash
pnpm install --frozen-lockfile
pnpm docker

cd ./tests
./prepare-pg.sh          # create test containers and set up the test database

cd sanity
pnpm run uitest --workers 2
```

`prepare-cockroach.sh` is the CockroachDB variant of the same stand.

Useful variants inside `tests/sanity`:

```bash
pnpm run uitest -- -g 'test title'   # run a single test by title
pnpm run debug                       # headed run with the Playwright inspector
pnpm run codegen                     # record a new test
```

After changing application code, rebuild the images (`pnpm docker`) and re-run
`./prepare-pg.sh` - Playwright tests exercise the built bundle, not the source tree.

## Integration tests

- `ws-tests/` - workspace, API and backup integration tests. `ws-tests/prepare.sh` sets up
  the stand, `prepare_data.sh` seeds it.
- `qms-tests/` - controlled-documents (QMS) suite.

## Additional testing

This project is also tested with [BrowserStack](https://www.browserstack.com/).
