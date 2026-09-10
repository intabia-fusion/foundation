#!/usr/bin/env bash

# Unit test phase stand. CockroachDB used to run here as a second flavor; it is dropped for now,
# see docs/memory/cockroach-dropped.md.
COMPOSE_FILES="-f docker-compose.yaml"

docker compose ${COMPOSE_FILES} -p sanity kill
docker compose ${COMPOSE_FILES} -p sanity down --volumes
docker compose ${COMPOSE_FILES} -p sanity up elastic postgres redpanda -d --force-recreate --renew-anon-volumes \
    --wait --wait-timeout 180
docker_exit=$?
if [ ${docker_exit} -eq 0 ]; then
    echo "Container started successfully"
else
    echo "Container started with errors"
    exit ${docker_exit}
fi

# Database URL on host side with default
DB_PURE_PG_URL_HOST="${DB_PURE_PG_URL_HOST:-postgresql://postgres:postgres@localhost:5433/postgres}"

echo "Running migrations for Postgres..."
# Without this the script returns 0 with an unmigrated database, and the whole test phase then
# burns its timeouts instead of failing here.
if ! DB_URL="$DB_PURE_PG_URL_HOST" node ../services/db-migrator/lib/index.js; then
    echo "Migration failed"
    exit 1
fi

./wait-elastic.sh 9201
