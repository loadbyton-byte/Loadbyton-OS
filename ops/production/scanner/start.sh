#!/bin/sh
set -eu
# The daemon refuses to become healthy without a downloaded signature database.
if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
  freshclam --config-file=/etc/clamav/freshclam.conf
fi
freshclam --daemon --config-file=/etc/clamav/freshclam.conf &
updater_pid=$!
clamd --config-file=/etc/clamav/clamd.conf &
scanner_pid=$!
trap 'kill "$scanner_pid" "$updater_pid" 2>/dev/null || true' TERM INT EXIT
wait "$scanner_pid"
