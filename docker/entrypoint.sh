#!/bin/sh
set -e

# The save directory is usually a bind mount owned by the host user.
# Apache runs PHP as www-data (uid 33), which needs to write room files into it.
DATA_DIR=/var/www/html/data/rooms
mkdir -p "$DATA_DIR"
if ! chown -R www-data:www-data "$DATA_DIR" 2>/dev/null; then
    echo "infinisweeper: warning: could not chown $DATA_DIR; make sure uid 33 (www-data) can write to it" >&2
fi

exec docker-php-entrypoint "$@"
