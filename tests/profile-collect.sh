#!/usr/bin/env bash
# Stops the profiled pods so V8 flushes their profiles into ./profiles/<service>/.
# SIGTERM only - a SIGKILL (docker kill / compose kill) loses the profile.
set -e

COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.purepg.yaml -f docker-compose.pgbouncer.yaml -f docker-compose.profile.yaml"
if [ -f "docker-compose.override.versions.yml" ]; then
    COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.purepg.yaml -f docker-compose.pgbouncer.yaml -f docker-compose.override.versions.yml -f docker-compose.profile.yaml"
fi

SERVICES=$(grep -E '^  [a-z0-9_-]+:$' docker-compose.profile.yaml | tr -d ' :' | tr '\n' ' ')
echo "Stopping (SIGTERM, up to 60s each): ${SERVICES}"
docker compose ${COMPOSE_FILES} -p sanity stop -t 60 ${SERVICES}

echo
FOUND=$(ls ./profiles/*/*.cpuprofile ./profiles/*/*.heapprofile 2>/dev/null | wc -l | tr -d ' ')
echo "Collected ${FOUND} profile(s):"
du -sh ./profiles/* 2>/dev/null || true
echo
echo "Report: ./profile-report.sh"
