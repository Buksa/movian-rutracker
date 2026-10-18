#!/bin/sh
# Starts a private Movian M7 for a live check of the plugin: its own Xvfb
# display, profile and cache under $LIVE_DIR, and the plugin installed from
# a ZIP the way Movian installs plugins. Prints the PID and the HTTP port;
# tools/live/stop.sh undoes all of it. A start that fails after Xvfb is up
# stops what it started and exits non-zero.
#
#   tools/live/start.sh [plugin.zip]     (default: build one with package.sh)
#
#   MOVIAN_DIR   Movian M7 tree with build.debug/movian (required). Movian runs
#                from there: its data root is the current directory.
#   LIVE_DIR     state directory (default ${TMPDIR:-/tmp}/rutracker-live);
#                a relative one is made absolute here
#   MOVIAN_ARGS  extra Movian arguments
#
# Another Movian may already hold :42000. This one takes whatever port
# Movian picks, found by PID, and stop.sh stops only this PID.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
. "$ROOT/tools/live/lib.sh"
MOVIAN_DIR=${MOVIAN_DIR:?set MOVIAN_DIR to a Movian M7 tree with build.debug/movian}
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-live}
# Absolute before anything changes directory: Movian runs from MOVIAN_DIR.
case "$LIVE_DIR" in /*) ;; *) LIVE_DIR=$(pwd)/$LIVE_DIR ;; esac
BIN=$MOVIAN_DIR/build.debug/movian

[ -x "$BIN" ] || { echo "no Movian binary at $BIN (set MOVIAN_DIR)" >&2; exit 1; }
if [ -f "$LIVE_DIR/pid" ] && kill -0 "$(cat "$LIVE_DIR/pid")" 2>/dev/null; then
  echo "already running: pid $(cat "$LIVE_DIR/pid"), port $(cat "$LIVE_DIR/port" 2>/dev/null)" >&2
  exit 1
fi

ZIP=${1:-$("$ROOT/m7-cookie-bridge/tools/package.sh" | head -1)}
mkdir -p "$LIVE_DIR/persistent/mrp/installed" "$LIVE_DIR/cache"
# swinst expects <id>@<origin>.zip and crashes on a name without "@".
cp "$ZIP" "$LIVE_DIR/persistent/mrp/installed/rutracker@local.zip"

# An X display of our own: xvfb-run would put a shell between us and the
# Movian PID.
D=90
while [ -e "/tmp/.X11-unix/X$D" ] || [ -e "/tmp/.X$D-lock" ]; do D=$((D + 1)); done
Xvfb ":$D" -screen 0 1280x720x24 -nolisten tcp > "$LIVE_DIR/xvfb.log" 2>&1 &
XPID=$!
echo $XPID > "$LIVE_DIR/xvfb.pid"
echo "$D" > "$LIVE_DIR/xvfb.display"
sleep 1

# Everything below may fail. The PIDs and the display are the ones this run
# started, so stopping them touches nothing else. The logs stay for reading.
PID=
abort() {
  echo "$1" >&2
  [ -z "$PID" ] || stop_pid "$PID" "--persistent $LIVE_DIR/persistent" || echo "Movian $PID still runs" >&2
  stop_pid "$XPID" "Xvfb :$D " || echo "Xvfb $XPID still runs" >&2
  rm -f "$LIVE_DIR/pid" "$LIVE_DIR/xvfb.pid" "$LIVE_DIR/xvfb.display" "$LIVE_DIR/port"
  exit 1
}

cd "$MOVIAN_DIR"
# shellcheck disable=SC2086
DISPLAY=":$D" "$BIN" --persistent "$LIVE_DIR/persistent" --cache "$LIVE_DIR/cache" \
  --disable-upnp --disable-upgrades -d $MOVIAN_ARGS > "$LIVE_DIR/movian.log" 2>&1 &
PID=$!
echo $PID > "$LIVE_DIR/pid"

# Movian listens on 42000, or on another port when that one is taken.
PORT=
i=0
while [ -z "$PORT" ] && [ $i -lt 30 ]; do
  sleep 1
  i=$((i + 1))
  alive "$PID" || abort "Movian exited, see $LIVE_DIR/movian.log"
  for p in $(ss -ltnpH 2>/dev/null | grep "pid=$PID," | awk '{print $4}' | sed 's/.*://'); do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; then PORT=$p; break; fi
  done
done
[ -n "$PORT" ] || abort "no HTTP port for pid $PID after 30 s"
echo "$PORT" > "$LIVE_DIR/port"
echo "pid $PID  port $PORT  display :$D  state $LIVE_DIR"
