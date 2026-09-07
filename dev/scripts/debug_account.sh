#!/bin/bash
set -e

cd ./pods/account
pnpm run bundle

port=${1:-3000}
echo "Running account on port: ${port}"
#MONGO_URL=mongodb://localhost:27017,
export DB_URL="mongodb://localhost:27018"
# DB_URL=postgresql://postgres:example@localhost:5432,
# DB_URL=postgresql://root@localhost:26257/defaultdb?sslmode=disable,
export SERVER_SECRET="secret"
export REGION_INFO="|America;europe|"
export REGION_CONFIG_JSON='{"regions":{"":{"transactors":[{"external":"ws://localhost:3334","internal":"ws://transactor:3334"},{"external":"ws://localhost:3335","internal":"ws://transactor-europe:3335"}],"collaborators":[{"external":"ws://localhost:3079","internal":"ws://collaborator:3079"},{"external":"ws://localhost:3080","internal":"ws://collaborator-europe:3080"}]},"europe":{"transactors":[{"external":"ws://localhost:3335","internal":"ws://transactor-europe:3335"}],"collaborators":[{"external":"ws://localhost:3080","internal":"ws://collaborator-europe:3080"}]}}}'
export ACCOUNTS_URL="http://localhost:${port}"
export ACCOUNT_PORT=${port}
export FRONT_URL="http://localhost:8080"
export STATS_URL="http://localhost:4900"
export SES_URL=
export MINIO_ACCESS_KEY="minioadmin"
export MINIO_SECRET_KEY="minioadmin"
export MINIO_ENDPOINT="localhost"
export ADMIN_EMAILS=admin
# DISABLE_SIGNUP=true,
# INIT_SCRIPT_URL=https://raw.githubusercontent.com/hcengineering/init/main/script.yaml,
# INIT_WORKSPACE=onboarding,
node --inspect bundle/bundle.js