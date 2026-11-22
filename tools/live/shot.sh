#!/bin/sh
# One screenshot of the display that tools/live/start.sh or mgo-start.sh
# runs Movian on (our Xvfb, or MGO_DISPLAY), as a PNG (ffmpeg's x11grab:
# neither xwd nor ImageMagick is installed here). Prints the file name.
#
#   tools/live/shot.sh [name]        -> $LIVE_DIR/shots/<name>.png
#
# Look at it with an image viewer (an agent: its Read tool). Do not shoot a
# page that shows a secret in clear text.
LIVE_DIR=${LIVE_DIR:?set LIVE_DIR to the state directory of the run}
mkdir -p "$LIVE_DIR/shots"
OUT=$LIVE_DIR/shots/${1:-$(date +%H%M%S)}.png
# Not our Xvfb: mgo-start.sh ran on MGO_DISPLAY. A rootless XWayland (WSLg)
# root window reads back black, so shoot the Movian Go window itself; its
# pixels are window coordinates (xdotool mousemove --window <id> x y).
# Compared, not "xvfb.pid exists": mgo-stop.sh --keep leaves our Xvfb running.
if [ -f "$LIVE_DIR/display" ] && [ "$(cat "$LIVE_DIR/display")" != ":$(cat "$LIVE_DIR/xvfb.display" 2>/dev/null)" ]; then
  D=$(cat "$LIVE_DIR/display") || exit 1
  WIN=$(DISPLAY="$D" xdotool search --all --pid "$(cat "$LIVE_DIR/pid")" --name '^Movian Go$' | head -1)
  [ -n "$WIN" ] || { echo "no Movian Go window of pid $(cat "$LIVE_DIR/pid") on $D" >&2; exit 1; }
  ffmpeg -loglevel error -y -f x11grab -window_id "$WIN" -i "$D" -frames:v 1 "$OUT" && echo "$OUT"
  exit
fi
D=$(cat "$LIVE_DIR/xvfb.display") || exit 1
SIZE=$(DISPLAY=":$D" xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $2; exit}')
ffmpeg -loglevel error -y -f x11grab -video_size "${SIZE:-1280x720}" -i ":$D" -frames:v 1 "$OUT" && echo "$OUT"
