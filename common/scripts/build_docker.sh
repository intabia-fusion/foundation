#!/usr/bin/env bash

roots='./server/server ./server/front ./pods/account ./pods/backup'
# ./products/tracker is temporary disabled

for r in $roots
do
  pushd $r
  pnpm run docker:build
  popd
done