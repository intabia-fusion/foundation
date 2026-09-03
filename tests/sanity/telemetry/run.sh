#!/usr/bin/env bash
#
# Copyright © 2026 Intabia Fusion.
#
# Licensed under the Eclipse Public License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License. You may
# obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
#

# Runs the sanity suite with container sampling and writes a self-contained report into
# runs/<timestamp>/. Playwright args pass through. SAMPLE=0 / STATS=0 disable collection.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# rushx normally puts this on PATH.
PATH="$ROOT/node_modules/.bin:$PATH"
export PATH

# fast-build serves a cached bundle happily, and a stale one yields metrics for absent code.
FRONT_CONTAINER="${FRONT_CONTAINER:-sanity-front0-1}"
if [ "${BUNDLE_CHECK:-1}" = "1" ]; then
  # Markers of the client telemetry path - bump when it changes again.
  for marker in __analyticsFlush __connStatsPush; do
    if docker exec "$FRONT_CONTAINER" sh -c "grep -q '$marker' /app/dist/bundle.*.js" 2>/dev/null; then
      continue
    fi
    echo "[telemetry] $FRONT_CONTAINER serves a stale bundle: no $marker marker in /app/dist" >&2
    echo "[telemetry] drop the 'bundle' and 'docker-build' phases from .fast-build-cache.json and rebuild" >&2
    echo "[telemetry] BUNDLE_CHECK=0 skips this check" >&2
    exit 1
  done
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="runs/${STAMP}"
mkdir -p "$OUT"

# Test policy in seconds: check every 1s, force a push at 10s, push early on 0.1% movement.
# Prod default 10/300/1% is restored after the run.
STATS_PID=""
if [ "${STATS:-1}" = "1" ]; then
  node "$HERE/stats.js" rate --min "${TELEMETRY_MIN:-1}" --max "${TELEMETRY_MAX:-10}" \
    --threshold "${TELEMETRY_THRESHOLD:-0.001}"
  node "$HERE/stats.js" wipe
  node "$HERE/stats.js" sample --out "$OUT/stats.ndjson" --interval "${STATS_INTERVAL:-1000}" &
  STATS_PID=$!
fi

SAMPLER_PID=""
if [ "${SAMPLE:-1}" = "1" ]; then
  node "$HERE/docker-sampler.js" --out "$OUT/docker.ndjson" --interval "${SAMPLE_INTERVAL:-1000}" &
  SAMPLER_PID=$!
  sleep 1
  if ! kill -0 "$SAMPLER_PID" 2>/dev/null; then
    echo "[telemetry] sampler did not start - is the stand up?" >&2
    SAMPLER_PID=""
  fi
fi

stop_sampler () {
  for pid in "$SAMPLER_PID" "$STATS_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
  done
}
trap stop_sampler EXIT INT TERM

cross-env LOCAL_URL=http://localhost:8083/_account/ DEV_URL= \
  playwright test -c ./tests/playwright.config.ts --grep-invert @llm "$@"
STATUS=$?

stop_sampler
SAMPLER_PID=""
STATS_PID=""

if [ "${STATS:-1}" = "1" ]; then
  node "$HERE/stats.js" fetch --out "$OUT/stats.json"
  node "$HERE/stats.js" rate --min 10 --max 300 --threshold 0.01
fi

# The next run overwrites these in place.
cp -f playwright-report.json "$OUT/" 2>/dev/null
cp -f step-report.ndjson "$OUT/" 2>/dev/null

node "$HERE/collect-run.js" --dir "$OUT" \
  --report "$OUT/playwright-report.json" \
  --steps "$OUT/step-report.ndjson" \
  --docker "$OUT/docker.ndjson" || exit $?
node "$HERE/render-report.js" --dir "$OUT" || exit $?

echo "[telemetry] open ${ROOT}/${OUT}/report.html"
exit $STATUS
