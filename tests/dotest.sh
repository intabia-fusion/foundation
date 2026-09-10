#!/bin/bash

# Build, bring the stand up, run the sanity suite with telemetry.
#
#   ./dotest.sh        # one run
#   ./dotest.sh 10     # ten runs in a row
#
# Iterations restore the workspaces between runs (./restore-pg.sh) and leave the containers up:
# accounts and workspaces pile up in the account DB run after run, which is the point - the load
# grows and flakes that only show up on a used stand get their chance. Look at the summary the
# script prints at the end, or later: cd sanity && node telemetry/stability.js

set -euo pipefail

ITERATIONS="${1:-1}"
if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [ "$ITERATIONS" -lt 1 ]; then
    echo "usage: $0 [iterations]" >&2
    exit 1
fi

pnpm install --frozen-lockfile
pnpm -w build
pnpm -w docker
./prepare-pg.sh
./tool-pg.sh sync-indexes indexes.yaml --apply

STAMPS=()
FAILED=0
for ((i = 1; i <= ITERATIONS; i++)); do
    if [ "$i" -gt 1 ]; then
        echo "=== restore before run $i/$ITERATIONS"
        ./restore-pg.sh
    fi
    echo "=== run $i/$ITERATIONS"
    # A red run is data, not a reason to stop: the whole point is to collect several in a row.
    (cd sanity && pnpm run uitest:telemetry --workers 5) || FAILED=$((FAILED + 1))
    STAMPS+=("$(ls -1t sanity/runs | head -1)")
done

if [ "$ITERATIONS" -gt 1 ]; then
    echo
    (cd sanity && node telemetry/stability.js "${STAMPS[@]}")
fi

exit "$FAILED"
