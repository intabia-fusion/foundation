#!/usr/bin/env bash

# Resets the sanity stand workspaces to their backup baseline without touching the containers.

set -e

../dev/test-base/run.sh "${STAND:-sanity}" restore
