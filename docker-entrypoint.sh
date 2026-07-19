#!/bin/sh
set -eu

data_dir="${PHOSPHENE_DATA_DIR:-/data}"
case "$data_dir" in
  /*) ;;
  *)
    echo "PHOSPHENE_DATA_DIR must be an absolute path" >&2
    exit 1
    ;;
esac

mkdir -p "$data_dir"
chown node:node "$data_dir"

exec gosu node "$@"
