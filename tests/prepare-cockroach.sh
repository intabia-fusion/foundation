#!/usr/bin/env bash

COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.cockroach.yaml"

docker compose ${COMPOSE_FILES} -p sanity kill
docker compose ${COMPOSE_FILES} -p sanity down --volumes --remove-orphans
docker compose ${COMPOSE_FILES} -p sanity up -d --force-recreate --renew-anon-volumes --remove-orphans
docker_exit=$?
if [ ${docker_exit} -eq 0 ]; then
    echo "Container started successfully"
else
    echo "Container started with errors"
    exit ${docker_exit}
fi

if [ "x$DO_CLEAN" == 'xtrue' ]; then
    echo 'Do docker Clean'
    docker system prune -a -f
fi

echo "Running migrations for CockroachDB..."
DB_URL="postgresql://root@localhost:26258/defaultdb?sslmode=disable" node ../services/db-migrator/lib/index.js

./wait-elastic.sh 9201

# Create user record in accounts
./tool-cockroach.sh create-account user1 -f John -l Appleseed -p 1234
./tool-cockroach.sh create-account user2 -f Kainin -l Dirak -p 1234
./tool-cockroach.sh create-account admin -f Super -l User -p 1234

# Create workspace record in accounts
./tool-cockroach.sh create-workspace sanity-ws email:user1

./restore-cockroach.sh
rm -rf ./sanity/.auth
