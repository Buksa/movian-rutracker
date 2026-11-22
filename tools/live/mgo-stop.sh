#!/bin/sh
# Stops what tools/live/mgo-start.sh started. Profiles are preserved by
# default for restart/session tests; pass --wipe when they are no longer
# needed. --keep stops only Movian Go and leaves Xvfb for an
# immediate restart. A directory without our marker is refused untouched.
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-mgo-live}
case "$LIVE_DIR" in /*) ;; *) LIVE_DIR=$(pwd)/$LIVE_DIR ;; esac
# shellcheck source=tools/live/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if [ ! -f "$LIVE_DIR/.rutracker-mgo-live" ]; then
  echo "$LIVE_DIR was not set up by tools/live/mgo-start.sh (no .rutracker-mgo-live): nothing stopped or wiped" >&2
  exit 1
fi

status=0
movian_gone=1
wipe=0
keep=0
case "${1:-}" in
  "") ;;
  --keep) keep=1 ;;
  --wipe) wipe=1 ;;
  *) echo "usage: tools/live/mgo-stop.sh [--keep|--wipe]" >&2; exit 2 ;;
esac
if [ -f "$LIVE_DIR/pid" ]; then
  PID=$(cat "$LIVE_DIR/pid")
  # CEF's renderer, GPU and utility processes are its children; only ours.
  CHILDREN=
  owns "$PID" "--persistent $LIVE_DIR/persistent" && CHILDREN=$(ps -o pid= --ppid "$PID" 2>/dev/null)
  if stop_pid "$PID" "--persistent $LIVE_DIR/persistent"; then
    rm -f "$LIVE_DIR/pid"
  else
    echo "movian-go $PID still runs; its profile is kept" >&2
    status=1
    movian_gone=0
  fi
  for c in $CHILDREN; do
    alive "$c" && kill "$c" 2>/dev/null
  done
fi

if [ $keep -eq 1 ]; then
  [ $movian_gone -eq 1 ] && echo "movian-go stopped; profile and Xvfb kept"
  exit $status
fi

if [ -f "$LIVE_DIR/xvfb.pid" ] && [ -f "$LIVE_DIR/xvfb.display" ]; then
  if stop_pid "$(cat "$LIVE_DIR/xvfb.pid")" "Xvfb :$(cat "$LIVE_DIR/xvfb.display") "; then
    rm -f "$LIVE_DIR/xvfb.pid" "$LIVE_DIR/xvfb.display"
  else
    echo "Xvfb $(cat "$LIVE_DIR/xvfb.pid") still runs" >&2
    status=1
  fi
fi

if [ $movian_gone -eq 1 ]; then
  rm -f "$LIVE_DIR/pid" "$LIVE_DIR/xvfb.pid" "$LIVE_DIR/xvfb.display" "$LIVE_DIR/display"
  if [ $wipe -eq 1 ]; then
    rm -rf "${LIVE_DIR:?}/persistent" "${LIVE_DIR:?}/cache" "${LIVE_DIR:?}/xdg" "${LIVE_DIR:?}/run" "${LIVE_DIR:?}/shots"
    rm -f "$LIVE_DIR/movian.log" "$LIVE_DIR/xvfb.log" "$LIVE_DIR/.rutracker-mgo-live"
    echo "stopped; $LIVE_DIR wiped"
  else
    echo "movian-go stopped; profile kept in $LIVE_DIR"
  fi
fi
exit $status
