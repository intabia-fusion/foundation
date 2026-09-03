#!/usr/bin/env bash

# Brings up the ws-tests stand: docker, migrations, accounts and workspaces are all driven from
# dev/test-base (node).

set -e

../dev/test-base/run.sh "${STAND:-ws}"

if [ "x$DO_CLEAN" == 'xtrue' ]; then
    echo 'Do docker Clean'
    docker system prune -a -f
fi
