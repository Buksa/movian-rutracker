#!/bin/sh
# Stops only the Movian and Xvfb started by tools/live/start.sh. Profiles are
# kept by default for restart/session tests; pass --wipe when they are no
# longer needed. A directory without our marker is refused untouched.
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-live}
case "$LIVE_DIR" in /*) ;; *) LIVE_DIR=$(pwd)/$LIVE_DIR ;; esac
# shellcheck source=tools/live/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Only a directory start.sh set up is ours: a LIVE_DIR typo or another
# Movian's profile (persistent/ and cache/ too) must stay untouched.
if [ ! -f "$LIVE_DIR/.rutracker-live" ]; then
  echo "$LIVE_DIR was not set up by tools/live/start.sh (no .rutracker-live): nothing stopped or wiped" >&2
  exit 1
fi

wipe=0
case "${1:-}" in
  "") ;;
  --keep) ;;
  --wipe) wipe=1 ;;
  *) echo "usage: tools/live/stop.sh [--keep|--wipe]" >&2; exit 2 ;;
esac

status=0
movian_gone=1

if [ -f "$LIVE_DIR/pid" ]; then
  if stop_pid "$(cat "$LIVE_DIR/pid")" "--persistent $LIVE_DIR/persistent"; then
    rm -f "$LIVE_DIR/pid"
  else
    echo "Movian $(cat "$LIVE_DIR/pid") still runs; its profile is kept" >&2
    status=1
    movian_gone=0
  fi
fi

# Xvfb is ours only if its command line has the display number start.sh
# recorded; without that record nothing is killed.
if [ -f "$LIVE_DIR/xvfb.pid" ]; then
  if [ -f "$LIVE_DIR/xvfb.display" ]; then
    if stop_pid "$(cat "$LIVE_DIR/xvfb.pid")" "Xvfb :$(cat "$LIVE_DIR/xvfb.display") "; then
      rm -f "$LIVE_DIR/xvfb.pid" "$LIVE_DIR/xvfb.display"
    else
      echo "Xvfb $(cat "$LIVE_DIR/xvfb.pid") still runs" >&2
      status=1
    fi
  else
    echo "no $LIVE_DIR/xvfb.display: not stopping Xvfb $(cat "$LIVE_DIR/xvfb.pid")" >&2
    status=1
  fi
fi

if [ $movian_gone -eq 1 ]; then
  rm -f "$LIVE_DIR/pid" "$LIVE_DIR/xvfb.pid" "$LIVE_DIR/xvfb.display" "$LIVE_DIR/port"
  if [ $wipe -eq 1 ]; then
    rm -rf "${LIVE_DIR:?}/persistent" "${LIVE_DIR:?}/cache"
    rm -f "$LIVE_DIR/movian.log" "$LIVE_DIR/xvfb.log" "$LIVE_DIR/.rutracker-live"
    echo "stopped; $LIVE_DIR wiped"
  else
    echo "stopped; profile kept in $LIVE_DIR"
  fi
fi
exit $status
