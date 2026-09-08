#!/bin/bash

set -euo pipefail

pnpm install --frozen-lockfile
pnpm -w build
pnpm -w docker
./prepare-pg.sh
./tool-pg.sh sync-indexes indexes.yaml --apply
pushd sanity
pnpm run uitest:telemetry --workers 5
