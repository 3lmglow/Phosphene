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

if ! mkdir -p "$data_dir"; then
  echo "Phosphene could not create $data_dir. Check the persistent volume mount and permissions." >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  if ! chown node:node "$data_dir" 2>/dev/null; then
    echo "Warning: could not change ownership of $data_dir; checking existing volume permissions." >&2
  fi
  if ! gosu node test -w "$data_dir"; then
    echo "Phosphene cannot write to $data_dir as the node user. Check the persistent volume permissions." >&2
    exit 1
  fi
  exec gosu node "$@"
fi

if [ ! -w "$data_dir" ]; then
  echo "Phosphene cannot write to $data_dir as uid $(id -u). Check the persistent volume permissions." >&2
  exit 1
fi

exec "$@"
