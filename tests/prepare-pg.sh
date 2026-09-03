#!/usr/bin/env bash

# Brings up the sanity stand. Docker, service health checks and workspace seeding live in
# dev/test-base (node); this script only keeps the pieces that are host-specific: the profiling
# overlay and the local LiveKit server.
#
#   ./prepare-pg.sh              # sanity workspaces only
#   ./prepare-pg.sh --full       # + the QMS workspaces, so qms-tests run on this same stand
#   ./prepare-pg.sh --profile    # CPU-profile every Node pod

set -e

STAND=sanity
PROFILE_ARG=false
while [ $# -gt 0 ]; do
    case "$1" in
        --full) STAND=full; shift ;;
        --profile) PROFILE_ARG=true; shift ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.purepg.yaml -f docker-compose.pgbouncer.yaml"
if [ -f "docker-compose.override.versions.yml" ]; then
    COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.override.versions.yml"
fi

# --profile: run every Node pod under V8's CPU profiler. The overlay is generated from the
# services this compose actually has - a hardcoded list breaks whenever a branch adds or drops
# a pod, since compose then sees a service with no image and rejects the project.
if [ "$PROFILE_ARG" = true ] || [ "x$PROFILE" = "xtrue" ]; then
    ./archive-report.sh
    mkdir -p ./profiles/.old-reports
    find ./profiles -mindepth 1 -maxdepth 1 ! -name .old-reports -exec rm -rf {} +
    if docker compose ${COMPOSE_FILES} -p sanity config --format json |
        node ./gen-profile-overlay.js > docker-compose.profile.yaml; then
        export STAND_EXTRA_COMPOSE=docker-compose.profile.yaml
    else
        echo "Failed to generate the profiling overlay - starting without it"
        rm -f docker-compose.profile.yaml
        exit 1
    fi
    echo "Profiling enabled. Run the tests, then: ./profile-collect.sh && ./profile-report.sh"
fi

../dev/test-base/run.sh "$STAND"

if [ "x$DO_CLEAN" == 'xtrue' ]; then
    echo 'Do docker Clean'
    docker system prune -a -f
fi

# Start LiveKit server in background. Writes pid/log to ./.livekit/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVEKIT_DIR="$SCRIPT_DIR/.livekit"
LIVEKIT_PID="$LIVEKIT_DIR/livekit.pid"
LIVEKIT_LOG="$LIVEKIT_DIR/livekit.log"
mkdir -p "$LIVEKIT_DIR"

# Stop previous instance — by pid file, by port, and by process name.
if [ -f "$LIVEKIT_PID" ]; then
    OLD_PID=$(cat "$LIVEKIT_PID" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Stopping previous LiveKit by pid file (pid=$OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$LIVEKIT_PID"
fi

# Kill anything bound to the test LiveKit port (covers manually-started instances).
PORT_PIDS=$(lsof -tiTCP:7890 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PORT_PIDS" ]; then
    echo "Stopping LiveKit on port 7890 (pids=$PORT_PIDS)..."
    echo "$PORT_PIDS" | xargs kill 2>/dev/null || true
fi

# Last-resort: kill livekit-server processes that point to our test config.
CFG_PIDS=$(pgrep -f "livekit-test-config.yaml" 2>/dev/null || true)
if [ -n "$CFG_PIDS" ]; then
    echo "Stopping livekit-server bound to test config (pids=$CFG_PIDS)..."
    echo "$CFG_PIDS" | xargs kill 2>/dev/null || true
fi

# Wait for graceful exit, then SIGKILL anything still on the port.
sleep 1
LEFTOVER=$(lsof -tiTCP:7890 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
    echo "Force-killing LiveKit leftovers (pids=$LEFTOVER)..."
    echo "$LEFTOVER" | xargs kill -9 2>/dev/null || true
fi

# LiveKit: on Linux use docker with host network (works in CI and local Linux).
# On macOS network_mode: host is unsupported, fall back to local livekit-server.
# Override with LIVEKIT_MODE=docker|local.
LIVEKIT_MODE="${LIVEKIT_MODE:-}"
if [ -z "$LIVEKIT_MODE" ]; then
    case "$(uname -s)" in
        Linux) LIVEKIT_MODE=docker ;;
        *)     LIVEKIT_MODE=local ;;
    esac
fi

if [ "$LIVEKIT_MODE" = "docker" ]; then
    echo "Starting LiveKit in docker (host network)..."
    docker compose -f docker-compose.livekit.yaml -p sanity-livekit down --remove-orphans 2>/dev/null || true
    docker compose -f docker-compose.livekit.yaml -p sanity-livekit up -d --force-recreate
elif command -v livekit-server >/dev/null 2>&1; then
    echo "Starting LiveKit (log: $LIVEKIT_LOG)..."
    nohup "$SCRIPT_DIR/run_livekit_test.sh" >"$LIVEKIT_LOG" 2>&1 &
    echo $! > "$LIVEKIT_PID"
    echo "LiveKit pid=$(cat "$LIVEKIT_PID")"
else
    echo "WARNING: livekit-server not installed; skipping LiveKit startup"
fi
