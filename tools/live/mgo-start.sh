#!/bin/sh
# Starts a private Movian Go (CEF build) for a live plugin check: profile and
# cache under $LIVE_DIR, an installed ZIP, analytics off and terms accepted.
# mgo-stop.sh preserves the profile by default; pass --wipe after E2E/session
# work is complete. docs/agents/live-e2e.md is the canonical procedure.
#
#   tools/live/mgo-start.sh [plugin.zip] [start-url]
#
# Run again after `mgo-stop.sh --keep` it restarts Movian Go on the same
# profile, reusing the Xvfb display.
#   MGO_DIR    Movian Go tree with movian-go built with the cef tag and the
#              CEF runtime in dist/cefrt (required)
#   MGO_BIN    optional binary override for testing a fresh build without
#              replacing MGO_DIR/movian-go
#   MGO_DISPLAY optional existing X11 display (e.g. :0); when unset, a
#              private Xvfb is started
#   MGO_PRESEED optional directory containing persistent/settings/keyring and
#              persistent/settings/dev; copied into this temporary profile
#   MGO_ARGS   optional extra arguments, e.g. "-d" or "-p <plugin-dir>"
#   LIVE_DIR   state directory (default ${TMPDIR:-/tmp}/rutracker-mgo-live)
#
# Dev only: Movian Go's Core HTTP control starts as usual (42000, or a free
# port when 42000 is taken) and is reachable from the LAN; see ss -ltnp.
#
# With MGO_DISPLAY set, the window uses that X11 display; otherwise it uses
# our private Xvfb. Under WSLg GLFW prefers Wayland, so Movian Go runs without
# WAYLAND_DISPLAY and with an empty XDG_RUNTIME_DIR. A start-url that opens a
# webpopup fails with neterror (GLW is not up yet): open such routes from UI.
set -e
umask 077
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
. "$ROOT/tools/live/lib.sh"
MGO_DIR=${MGO_DIR:?set MGO_DIR to a Movian Go tree with a CEF build}
MGO_DIR=$(cd "$MGO_DIR" && pwd)
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-mgo-live}
case "$LIVE_DIR" in /*) ;; *) LIVE_DIR=$(pwd)/$LIVE_DIR ;; esac
BIN=${MGO_BIN:-$MGO_DIR/movian-go}
CEF=$MGO_DIR/dist/cefrt
MGO_PRESEED=${MGO_PRESEED:-}
if [ -n "$MGO_PRESEED" ]; then
  MGO_PRESEED=$(cd "$MGO_PRESEED" && pwd)
  [ -f "$MGO_PRESEED/persistent/settings/keyring" ] || { echo "preseed keyring is missing" >&2; exit 1; }
  [ -f "$MGO_PRESEED/persistent/settings/dev" ] || { echo "preseed dev settings are missing" >&2; exit 1; }
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MGO_PRESEED/persistent/settings/dev" >/dev/null
fi


[ -x "$BIN" ] || { echo "no movian-go at $BIN" >&2; exit 1; }
[ -d "$CEF/Release" ] || { echo "no CEF runtime at $CEF (Release merged with Resources)" >&2; exit 1; }
if [ -f "$LIVE_DIR/pid" ] && alive "$(cat "$LIVE_DIR/pid")"; then
  echo "already running: pid $(cat "$LIVE_DIR/pid")" >&2
  exit 1
fi

ZIP=${1:-$("$ROOT/m7-cookie-bridge/tools/package.sh" | head -1)}
P=$LIVE_DIR/persistent
mkdir -p "$P/settings" "$P/mrp/installed" "$P/plugins/rutracker@local/settings" "$LIVE_DIR/cache" "$LIVE_DIR/xdg" "$LIVE_DIR/run"
chmod 700 "$LIVE_DIR" "$P" "$P/settings" "$P/mrp" "$P/mrp/installed" "$P/plugins" "$P/plugins/rutracker@local" "$P/plugins/rutracker@local/settings" "$LIVE_DIR/cache" "$LIVE_DIR/xdg" "$LIVE_DIR/run"
chmod -R go-rwx "$P" "$LIVE_DIR/cache" "$LIVE_DIR/xdg" "$LIVE_DIR/run"
: >> "$LIVE_DIR/movian.log"
: >> "$LIVE_DIR/xvfb.log"
chmod 600 "$LIVE_DIR/movian.log" "$LIVE_DIR/xvfb.log"
# mgo-stop.sh operates only on directories carrying this marker.
: > "$LIVE_DIR/.rutracker-mgo-live"
if [ -n "$MGO_PRESEED" ]; then
  install -m 600 "$MGO_PRESEED/persistent/settings/keyring" "$P/settings/keyring"
  install -m 600 "$MGO_PRESEED/persistent/settings/dev" "$P/settings/dev"
  # Only the temporary copy is changed if its analytics flag is absent.
  node -e 'const fs=require("fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p,"utf8"));if(d.disableanalytics!==1){d.disableanalytics=1;fs.writeFileSync(p,JSON.stringify(d));}' "$P/settings/dev"
else
  echo '{"disableanalytics": 1}' > "$P/settings/dev"
fi
cp "$ZIP" "$P/mrp/installed/rutracker@local.zip"
chmod 600 "$P/settings/dev" "$P/mrp/installed/rutracker@local.zip"
# The terms popup blocks the plugin; STPP cannot set it (Node's WebSocket
# refuses Movian Go's handshake), so the settings file is seeded.
echo '{"tosaccepted":true}' > "$P/plugins/rutracker@local/settings/rutracker"

if [ -n "${MGO_DISPLAY:-}" ]; then
  DISPLAY_VALUE=$MGO_DISPLAY
  DISPLAY="$DISPLAY_VALUE" xdpyinfo >/dev/null 2>&1 || { echo "cannot connect to X11 display $DISPLAY_VALUE" >&2; exit 1; }
else
  if [ -f "$LIVE_DIR/xvfb.pid" ] && [ -f "$LIVE_DIR/xvfb.display" ] && alive "$(cat "$LIVE_DIR/xvfb.pid")"; then
    D=$(cat "$LIVE_DIR/xvfb.display")
  else
    D=91
    while [ -e "/tmp/.X11-unix/X$D" ] || [ -e "/tmp/.X$D-lock" ]; do D=$((D + 1)); done
    Xvfb ":$D" -screen 0 1280x720x24 -nolisten tcp > "$LIVE_DIR/xvfb.log" 2>&1 &
    echo $! > "$LIVE_DIR/xvfb.pid"
    echo "$D" > "$LIVE_DIR/xvfb.display"
    sleep 1
  fi
  DISPLAY_VALUE=":$D"
fi
# The display Movian Go is on, for shot.sh and xdotool.
echo "$DISPLAY_VALUE" > "$LIVE_DIR/display"

PID=
abort() {
  echo "$1" >&2
  "$ROOT/tools/live/mgo-stop.sh" > /dev/null 2>&1 || echo "stop failed: run tools/live/mgo-stop.sh" >&2
  exit 1
}

cd "$MGO_DIR"
# shellcheck disable=SC2086
env -u WAYLAND_DISPLAY XDG_RUNTIME_DIR="$LIVE_DIR/run" DISPLAY="$DISPLAY_VALUE" XDG_CACHE_HOME="$LIVE_DIR/xdg" \
  CEF_DIR="$CEF" LD_LIBRARY_PATH="$CEF/Release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$BIN" ${MGO_ARGS:-} --persistent "$P" --cache "$LIVE_DIR/cache" ${2:+"$2"} >> "$LIVE_DIR/movian.log" 2>&1 &
PID=$!
echo $PID > "$LIVE_DIR/pid"

# By PID: on a desktop display the owner's own Movian Go may have a window too.
i=0
until DISPLAY="$DISPLAY_VALUE" xdotool search --all --pid "$PID" --name '^Movian Go$' > /dev/null 2>&1; do
  i=$((i + 1))
  alive "$PID" || abort "movian-go exited, see $LIVE_DIR/movian.log"
  [ $i -lt 30 ] || abort "no Movian Go window on $DISPLAY_VALUE"
  sleep 1
done
echo "pid $PID  display $DISPLAY_VALUE  state $LIVE_DIR"
