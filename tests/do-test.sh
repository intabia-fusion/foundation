#!/usr/bin/env bash
#
# Prepares the stand and prints what to run next. It deliberately does not run the tests itself:
# playwright's reporter needs a real TTY for colour and live progress, and any wrapper (pipe,
# tee, subshell) downgrades it to plain line output.
#
#   ./do-test.sh              # clean stand, no profiling
#   ./do-test.sh --profile    # + CPU-profile every Node pod (same as ./do-test-profile.sh)
#   ./do-test.sh --heap       # + sample allocations instead of CPU
#   ./do-test.sh --build      # rebuild images first
#   ./do-test.sh --collect    # skip prepare, collect profiles + report
#   ./do-test.sh --report     # skip prepare, re-report from ./profiles
set -e

BUILD=false
PREPARE=true
PROFILE=false
COLLECT=false
REPORT=false
TOP=30

while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE=true; shift ;;
        --heap) export PROFILE_NODE_FLAGS='--heap-prof --heap-prof-dir'; PROFILE=true; shift ;;
        --build) BUILD=true; shift ;;
        --collect) PREPARE=false; COLLECT=true; REPORT=true; shift ;;
        --report) PREPARE=false; REPORT=true; shift ;;
        -t|--top) TOP="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

if [ "$BUILD" = true ]; then
    echo "==> Rebuilding images"
    (cd .. && rush fast-build:docker)
fi

if [ "$PREPARE" = true ]; then
    if [ "$PROFILE" = true ]; then
        ./prepare-pg.sh --profile
    else
        ./prepare-pg.sh
    fi

    # Same steps CI does after the stand is up: the spec files are compiled from the workspace,
    # and playwright needs its browser present.
    echo "==> Building the test package"
    (cd .. && rush fast-build --to @hcengineering/tests-sanity)
    echo "==> Ensuring playwright browsers"
    (cd sanity && rushx ci)

    echo
    echo "====================================================================="
    if [ "$PROFILE" = true ]; then
        PROFILED=$(grep -cE '^  [a-z0-9_-]+:$' docker-compose.profile.yaml || echo 0)
        echo " READY. Stand is up, ${PROFILED} pods are being profiled."
    else
        echo " READY. Stand is up."
    fi
    cat <<'EOF'

 1) Run the tests here, in this terminal:

      cd sanity && rushx uitest

    (run them yourself - a pipe or subshell strips playwright's
     colour and live progress)

 2) After a red run, to see what actually broke:

      cd sanity && node analyze_failures.js
EOF
    if [ "$PROFILE" = true ]; then
        cat <<'EOF'

 3) When the run is finished, take the snapshots:

      ./do-test.sh --collect

    That stops the profiled pods so V8 flushes each profile into
    ./profiles/<service>/, then prints the hot-path report.
EOF
    fi
    echo "====================================================================="
    exit 0
fi

if [ "$COLLECT" = true ]; then
    ./profile-collect.sh
fi

if [ "$REPORT" = true ]; then
    # Source maps are tens of MB each; the default heap is not enough to hold them.
    ./archive-report.sh
    node --max-old-space-size=8192 ./profile-report.js ./profiles "$TOP" | tee ./profiles/report.txt
    echo
    echo "Saved: ./profiles/report.txt"
    echo "Failed tests: cd sanity && node analyze_failures.js"
fi
