#!/usr/bin/env bash
#
# Brings the stand up with CPU profiling and prints what to run next. It deliberately does not
# run the tests itself: playwright's reporter needs a real TTY for colour and live progress, and
# any wrapper (pipe, tee, subshell) downgrades it to plain line output.
#
#   ./do-test-profile.sh            # prepare a profiled stand
#   ./do-test-profile.sh --heap     # sample allocations instead of CPU
#   ./do-test-profile.sh --build    # rebuild images first
#   ./do-test-profile.sh --collect  # skip prepare, just collect + report
#   ./do-test-profile.sh --report   # skip prepare, just re-report from ./profiles
set -e

BUILD=false
PREPARE=true
COLLECT=false
REPORT=false
TOP=30

while [ $# -gt 0 ]; do
    case "$1" in
        --heap) export PROFILE_NODE_FLAGS='--heap-prof --heap-prof-dir'; shift ;;
        --build) BUILD=true; shift ;;
        --collect) PREPARE=false; COLLECT=true; REPORT=true; shift ;;
        --report) PREPARE=false; REPORT=true; shift ;;
        -t|--top) TOP="$2"; shift 2 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

if [ "$BUILD" = true ]; then
    echo "==> Rebuilding images"
    (cd .. && rush fast-build:docker)
fi

if [ "$PREPARE" = true ]; then
    ./prepare-pg.sh --profile

    # Same steps CI does after the stand is up: the spec files are compiled from the workspace,
    # and playwright needs its browser present.
    echo "==> Building the test package"
    (cd .. && rush fast-build --to @hcengineering/tests-sanity)
    echo "==> Ensuring playwright browsers"
    (cd sanity && rushx ci)

    cat <<'EOF'

=====================================================================
 Stand is up with profiling. Run the tests yourself, in this terminal
 (a wrapper would strip playwright's colour and live progress):

   cd sanity && rushx uitest

 Then collect and report:

   ./do-test-profile.sh --collect
=====================================================================
EOF
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
