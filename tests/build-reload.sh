#!/usr/bin/env bash

# Restore workspace contents in mongo/elastic
pnpm docker:build

# Re-assign user to workspace.
docker compose -p sanity up $1 -d --force-recreate
