#!/usr/bin/env bash
# Usage: ./profile-report.sh [topN]
node ./profile-report.js ./profiles "${1:-25}"
