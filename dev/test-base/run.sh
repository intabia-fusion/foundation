#!/usr/bin/env bash

# Runs the stand tool. The tool pulls in model packages that only resolve through esbuild, so it is
# executed from the bundle rather than from lib/.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$DIR/bundle/bundle.js"

# Always rebuilt (~1s): the bundle inlines other packages, so checking only src/ for staleness would
# silently run the stand on old code.
(cd "$DIR" && node ../../common/scripts/esbuild.js --entry=src/main.ts --keep-names=true --external=snappy --sourcemap=external >/dev/null)

node --max-old-space-size=8096 ${TOOL_OPTIONS} "$BUNDLE" "$@"
