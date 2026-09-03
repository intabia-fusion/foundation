#!/usr/bin/env bash
# Sequential cherry-pick driver for the upstream sync. Every conflict resolves to
# OUR side; commits that end up empty after that are skipped. Each pick that
# lands is recorded in the gh-picker applied cache, and `-x` puts the upstream
# hash into the message so future runs can identify it.
#
#   dev/pick-upstream.sh <file-with-hashes-one-per-line> [logfile]
#
# Never stops the batch: a commit git cannot apply at all is aborted, logged as
# FAILED and left for manual handling.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

list=${1:?usage: dev/pick-upstream.sh <hashes-file> [logfile]}
log=${2:-.git/pick-upstream.log}
picker=dev/gh-picker/gh-picker
: >"$log"

say() { echo "$*" | tee -a "$log"; }

# resolve_ours stages our side for every unmerged path.
resolve_ours() {
  local xy path
  git status --porcelain | while read -r xy path; do
    case "$xy" in
      UU | AA) git checkout --ours -- "$path" >/dev/null 2>&1 && git add -- "$path" ;;
      AU | UD) git add -- "$path" ;;      # we have it / we kept it -> keep ours
      UA | DU | DD) git rm -f -- "$path" >/dev/null ;; # we don't have it -> stay without
      *) continue ;;
    esac
    echo "      ours: $path" >>"$log"
  done
}

ok=0 empty=0 resolved=0 failed=0
while read -r hash; do
  [ -z "$hash" ] && continue
  subject=$(git log -1 --format='%h %s' "$hash")
  if git cherry-pick -x -X ours "$hash" >/dev/null 2>&1; then
    say "OK       $subject"
    ok=$((ok + 1))
    "$picker" applied "$hash" >/dev/null
    continue
  fi

  resolve_ours
  if git diff --cached --quiet; then
    git cherry-pick --skip >/dev/null 2>&1
    say "EMPTY    $subject"
    empty=$((empty + 1))
    "$picker" applied "$hash" >/dev/null
    continue
  fi
  if GIT_EDITOR=true git cherry-pick --continue >/dev/null 2>&1; then
    say "RESOLVED $subject"
    resolved=$((resolved + 1))
    "$picker" applied "$hash" >/dev/null
  else
    git cherry-pick --abort >/dev/null 2>&1
    say "FAILED   $subject"
    failed=$((failed + 1))
  fi
done <"$list"

say ""
say "ok=$ok resolved-ours=$resolved empty=$empty failed=$failed  log=$log"
[ "$failed" = 0 ]
