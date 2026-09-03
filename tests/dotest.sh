#!/bin/bash

set -euo pipefail

rush update
rush fast-build:validate
rush fast-build:docker
./prepare-pg.sh
./tool-pg.sh sync-indexes indexes.yaml --apply
pushd sanity
rushx uitest:telemetry --workers 5
