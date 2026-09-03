#!/usr/bin/env bash
# Delete local tags that came from a foreign remote and are absent from the
# remotes we actually publish to. Dry run by default.
#
#   ./dev/clean-upstream-tags.sh            # show what would be deleted
#   ./dev/clean-upstream-tags.sh --apply    # delete + stop fetching upstream tags
#   FROM=upstream KEEP=origin,haiodo ./dev/clean-upstream-tags.sh --apply
set -euo pipefail

FROM=${FROM:-upstream}
KEEP=${KEEP:-origin,haiodo}
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

remote_tags() {
  git ls-remote --tags "$1" | grep -v '\^{}$' | awk '{print $2}' | sed 's|refs/tags/||' | sort -u
}

git for-each-ref refs/tags --format='%(refname:short)' | sort -u >"$tmp/local"
remote_tags "$FROM" >"$tmp/from"

: >"$tmp/keep"
IFS=, read -ra keeps <<<"$KEEP"
for r in "${keeps[@]}"; do
  if git remote get-url "$r" >/dev/null 2>&1; then
    remote_tags "$r" >>"$tmp/keep"
  else
    echo "warn: no remote '$r', skipping" >&2
  fi
done
sort -u "$tmp/keep" -o "$tmp/keep"

comm -12 "$tmp/local" "$tmp/from" | comm -23 - "$tmp/keep" >"$tmp/del"

count() { wc -l <"$1" | tr -d ' '; }
n=$(count "$tmp/del")
echo "local=$(count "$tmp/local")  $FROM=$(count "$tmp/from")  keep[$KEEP]=$(count "$tmp/keep")  to-delete=$n"

[ "$n" = 0 ] && exit 0

if [ "$APPLY" = 1 ]; then
  xargs -n 100 git tag -d <"$tmp/del" >/dev/null
  git config "remote.$FROM.tagOpt" --no-tags
  echo "deleted $n local tags; remote.$FROM.tagOpt=--no-tags"
else
  cat "$tmp/del"
  echo "--- dry run, rerun with --apply ---"
fi
