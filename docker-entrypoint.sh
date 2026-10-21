#!/bin/sh
# A disk mounted by the host is often owned by root. Fix that, then run the app as the unprivileged "node" user.
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
exec su-exec node "$@"
