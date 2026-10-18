#!/bin/sh
# Stops the Movian started by tools/live/start.sh, and only that one, then
# wipes its state: the plugin store there holds the bridged session.
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-live}

# Kill the PID in $1 only if its command line still contains $2: a PID file
# can outlive its process, and the number may now belong to someone else.
stop() {
  [ -f "$1" ] || return 0
  pid=$(cat "$1")
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$2"; then kill "$pid"; fi
  rm -f "$1"
}

stop "$LIVE_DIR/pid" "--persistent $LIVE_DIR/persistent"
stop "$LIVE_DIR/xvfb.pid" "Xvfb"
sleep 1
rm -rf "${LIVE_DIR:?}/persistent" "${LIVE_DIR:?}/cache"
rm -f "$LIVE_DIR/port" "$LIVE_DIR/movian.log" "$LIVE_DIR/xvfb.log"
echo "stopped; $LIVE_DIR wiped"
