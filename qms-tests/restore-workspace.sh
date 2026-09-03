#!/usr/bin/env bash

# Restores the QMS workspace contents from backup to a clean baseline.

set -e

../dev/test-base/run.sh qms restore
