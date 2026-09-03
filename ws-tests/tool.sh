#!/usr/bin/env bash

export MODEL_VERSION=$(node ../common/scripts/show_version.js)
export MINIO_ACCESS_KEY=minioadmin
export MINIO_SECRET_KEY=minioadmin
export STORAGE_CONFIG="datalake|http://localhost:8083/_datalake"
export ACCOUNTS_URL=http://localhost:8083/_account
export REGION_CONFIG=./region-config.yaml
export ACCOUNT_DB_URL=postgresql://postgres:postgres@localhost:5433/postgres
export ELASTIC_URL=http://localhost:9201
export SERVER_SECRET=secret
# America region
export DB_URL=postgres://postgres:postgres@localhost:5433/region_main
export QUEUE_CONFIG=localhost:19093

# Check if local bundle.js exists and use it if available
BUNDLE_PATH="../dev/tool/bundle/bundle.js"
if [ -f "./bundle.js" ]; then
  BUNDLE_PATH="./bundle.js"
fi

node ${TOOL_OPTIONS} --max-old-space-size=8096 $BUNDLE_PATH "$@"
