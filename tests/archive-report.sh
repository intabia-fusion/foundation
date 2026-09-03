#!/usr/bin/env bash
#
# Moves an existing hot-path report aside so the next run does not overwrite it. Comparing a
# change against the run before it is the whole point of the report, and both `prepare-pg.sh
# --profile` (which clears ./profiles) and the `tee` in do-test.sh used to destroy it.
#
# Archived reports land in ./profiles/.old-reports/, named after when the report was written.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

REPORT=./profiles/report.txt
[ -f "$REPORT" ] || exit 0

mkdir -p ./profiles/.old-reports
STAMP=$(date -r "$REPORT" +%Y%m%d-%H%M%S 2>/dev/null || date +%Y%m%d-%H%M%S)
TARGET=./profiles/.old-reports/report-$STAMP.txt

# Two runs inside the same second would otherwise clobber each other.
SUFFIX=1
while [ -e "$TARGET" ]; do
    TARGET=./profiles/.old-reports/report-$STAMP-$SUFFIX.txt
    SUFFIX=$((SUFFIX + 1))
done

mv "$REPORT" "$TARGET"
echo "==> Previous report kept as $TARGET"

# Keep the last 20; a report is ~20KB, but there is no reason to grow without bound.
ls -1t ./profiles/.old-reports/report-*.txt 2>/dev/null | tail -n +21 | while read -r old; do
    rm -f "$old"
done
