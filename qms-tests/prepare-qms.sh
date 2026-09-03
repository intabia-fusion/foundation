#!/usr/bin/env bash

# Standalone QMS test stand. Brings up its own docker stack under the `qms` compose project (same
# ports as tests/, so run it only when the tests/ `sanity` stand is down) and seeds the QMS
# workspaces. Everything is driven from dev/test-base (node).

set -e

../dev/test-base/run.sh qms
