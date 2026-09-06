#!/usr/bin/env bash
set -euo pipefail

# Compare slow-client drop ON vs OFF.
# Rebuilds docker images once, then runs the benchmark twice, restarting
# the test stand between runs with the appropriate WS_SLOW_CLIENT_DROP value.
#
# Tunables (env): BENCH_SUBS, BENCH_DOCS, BENCH_BURST, BENCH_WAIT_MS, BENCH_STATS_TARGETS
# Override the default test stand path with TESTS_DIR.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="${TESTS_DIR:-$ROOT/tests}"
API_DIR="$ROOT/ws-tests/api-tests"
OUT_DIR="${BENCH_STATS_DIR:-/tmp/bench-stats}"

export BENCH_SUBS="${BENCH_SUBS:-50}"
export BENCH_DOCS="${BENCH_DOCS:-1000}"
export BENCH_BURST="${BENCH_BURST:-100}"
export BENCH_WAIT_MS="${BENCH_WAIT_MS:-180000}"
export BENCH_STATS_TARGETS="${BENCH_STATS_TARGETS:-sanity-transactor0-1,sanity-transactor1-1}"
export BENCH_STATS_DIR="$OUT_DIR"
export BENCH_BROADCAST=1
export BENCH_WS="${BENCH_WS:-sanity-ws}"
export BENCH_URL="${BENCH_URL:-http://localhost:8083}"

mkdir -p "$OUT_DIR"

run_one () {
  local label="$1"
  local drop="$2"
  echo "==> Run [$label]: WS_SLOW_CLIENT_DROP=$drop"
  pushd "$TESTS_DIR" >/dev/null
  WS_SLOW_CLIENT_DROP="$drop" ./prepare-pg.sh >/tmp/prep-${label}.log 2>&1
  popd >/dev/null
  pushd "$API_DIR" >/dev/null
  BENCH_LABEL="$label" pnpm run api-test --testPathPattern broadcast.benchmark | tee "$OUT_DIR/run-${label}.log"
  popd >/dev/null
}

echo "==> Rebuilding docker images (pnpm docker)"
pushd "$ROOT" >/dev/null
pnpm docker >/tmp/bench-docker-build.log 2>&1
popd >/dev/null

run_one "drop-off" 0
run_one "drop-on" 1

echo "==> Done. Reports in $OUT_DIR"
ls -1 "$OUT_DIR"/bench-*.json
echo
echo "==> Side-by-side summary"
for f in "$OUT_DIR"/bench-*.json; do
  echo "--- $(basename "$f") ---"
  cat "$f"
  echo
done
