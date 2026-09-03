#!/bin/bash

pushd ../
./restore-pg.sh "$@"
popd
