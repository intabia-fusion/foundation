# Thin wrapper over the pnpm scripts: every target forwards to the script of the same name,
# so the two can never drift. Extra flags go through ARGS.
#
#   make build
#   make build:lint ARGS="--to @hcengineering/core"

MAKEFLAGS += --always-make
.DEFAULT_GOAL := build

install:
	pnpm install --frozen-lockfile

%:
	pnpm run $@ $(ARGS)
