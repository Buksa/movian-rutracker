#!/bin/sh
# Drives one Android phone for a live Movian Go check over adb: a plugin
# install through HTTP Control (checked by sha256 on the phone), a logcat file
# on the phone, and cleanup. Movian Go only (com.moviango.mediaplayer, debug
# APK): M7 Android cannot take the install route (docs/agents/live-e2e.md).
#
#   tools/live/android.sh <serial> install <zip>      forward, POST the ZIP, compare sha256
#   tools/live/android.sh <serial> log-start          logcat to a file of its own on the phone (one run at a time)
#   tools/live/android.sh <serial> log-pull <dir>     copy the log file(s) into <dir> (mode 0600)
#   tools/live/android.sh <serial> log-stop           stop that logcat and delete the file(s) on the phone
#   tools/live/android.sh <serial> stop               remove the adb forward that install added
#
# PORT is the local port for HTTP Control (default 42100). LIVE_DIR holds the
# forward marker (default ${TMPDIR:-/tmp}/rutracker-android-live).
# The logcat is stopped by the PID and start time recorded on the phone, and only when that
# PID is still a logcat writing our file: no process-name matching, since the
# phone may run other logcats (docs/agents/live-e2e.md).
set -e
umask 077

die() { echo "$*" >&2; exit 1; }

is_sha256() { expr "$1" : '[0-9a-f]\{64\}$' >/dev/null; }

[ $# -ge 2 ] || die "usage: tools/live/android.sh <serial> install|log-start|log-pull|log-stop|stop [args]"
S=$1
CMD=$2
shift 2

PKG=com.moviango.mediaplayer
PORT=${PORT:-42100}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE_DIR=${LIVE_DIR:-${TMPDIR:-/tmp}/rutracker-android-live}
PIDF=/data/local/tmp/rutracker-live.pid
# Each run logs to a file of its own; the marker holds "pid starttime file".
LOG=/data/local/tmp/rutracker-live.$(date +%s)$$.log
# Device side: st prints a pid's start time (stat field 22, after the ")" of comm);
# owns <pid> <start> <file> holds while that very process is a logcat with -f <file>;
# gone <pid> <start> holds only when the pid is absent or its start time reads different.
# An empty marker is a log-start between claiming it and writing it. mark accepts only
# a file named as LOG is (digits between the dots), so its rm cannot reach another path.
DEV_OWNS="st() { x=\$(cat /proc/\$1/stat 2>/dev/null) || return 1; x=\${x##*) }; set -- \$x; shift 19; echo \$1; }; owns() { [ -n \"\$2\" ] && [ \"\$(st \$1)\" = \"\$2\" ] && [ \"\$(basename \"\$(readlink /proc/\$1/exe 2>/dev/null)\")\" = logcat ] && case \" \$(tr '\\0' ' ' < /proc/\$1/cmdline 2>/dev/null) \" in *\" -f \$3 \"*) return 0 ;; esac; return 1; }; gone() { [ -d /proc/\$1 ] || return 0; y=\$(st \$1) || return 1; [ \"\$y\" != \"\$2\" ]; }; mark() { [ -f $PIDF ] || return 1; [ -s $PIDF ] || { echo STARTING; exit 0; }; read p s l < $PIDF; r=\${l#/data/local/tmp/rutracker-live.}; r=\${r%.log}; case \$r in ''|*[!0-9]*) echo BADMARK; exit 0 ;; esac; [ \"\$l\" = /data/local/tmp/rutracker-live.\$r.log ] || { echo BADMARK; exit 0; }; }"

adb -s "$S" get-state >/dev/null 2>&1 || die "no adb device $S"

# One marker per serial and port: the mapping we made, "tcp:PORT tcp:42000".
MARK="$LIVE_DIR/forward.$S.$PORT"
MINE="tcp:$PORT tcp:42000"

forward_add() {
  mkdir -p "$LIVE_DIR"
  chmod 700 "$LIVE_DIR"
  # Already ours and still in place: nothing to add.
  if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$MINE" ] && adb -s "$S" forward --list | grep -qxF "$S $MINE"; then
    return 0
  fi
  # A local port taken by any serial or target is not ours to replace.
  if adb -s "$S" forward --list | awk -v l="tcp:$PORT" '$2 == l { taken = 1 } END { exit !taken }'; then
    die "tcp:$PORT is already forwarded (adb forward --list); choose another PORT"
  fi
  adb -s "$S" forward --no-rebind "tcp:$PORT" tcp:42000 >/dev/null || die "cannot forward tcp:$PORT to the phone"
  printf '%s\n' "$MINE" > "$MARK"
}

case $CMD in
  install)
    ZIP=${1:?usage: android.sh <serial> install <zip>}
    [ -f "$ZIP" ] || die "no ZIP at $ZIP"
    want_line=$(sha256sum "$ZIP") || die "cannot read $ZIP to hash it"
    want=${want_line%% *}
    is_sha256 "$want" || die "no sha256 for $ZIP"
    PLUGIN_ID=$(node -p 'require(process.argv[1]).id' "$ROOT/plugin.json")
    forward_add
    curl -fsS -X POST -H 'Content-Type: application/zip' --data-binary "@$ZIP" \
      "http://127.0.0.1:$PORT/api/plugin/install" >/dev/null
    got_raw=$(adb -s "$S" shell run-as "$PKG" sha256sum "files/mrp/installed/$PLUGIN_ID@local.zip" 2>/dev/null) ||
      die "adb run-as sha256sum failed on $S"
    got=$(printf '%s' "$got_raw" | tr -d '\r' | cut -d' ' -f1)
    [ "$got" = "$want" ] || die "installed $PLUGIN_ID differs on the phone: want sha256 $want, got '${got:-nothing}'"
    echo "installed $PLUGIN_ID, sha256 $want"
    ;;

  log-start)
    # One run at a time: a marker means a run that log-stop has not ended, live or not.
    out=$(adb -s "$S" shell "$DEV_OWNS; umask 077; if mark; then if owns \$p \$s \$l; then echo BUSY \$p; else echo STALE; fi; exit 0; fi; set -C; { : > $PIDF; } 2>/dev/null || { echo STARTING; exit 0; }; set +C; setsid nohup logcat -v time -f $LOG -r 20000 -n 2 </dev/null >/dev/null 2>&1 & p=\$!; sleep 1; s=\$(st \$p); if owns \$p \"\$s\" $LOG; then echo \"\$p \$s $LOG\" > $PIDF; echo STARTED \$p; else kill \$p 2>/dev/null; rm -f $PIDF $LOG $LOG.*; echo NOTLOGCAT; fi") || die "adb shell failed on $S"
    case $out in
      *BADMARK*) die "$PIDF on $S does not name a log of ours; left alone" ;;
      *STARTING*) die "another log-start is starting on $S; try again" ;;
      *BUSY*) die "a logcat of ours still runs on the phone (${out##*BUSY }); run log-stop first" ;;
      *STALE*) die "the last run's logcat is gone but its marker is left; run log-pull, then log-stop" ;;
      *STARTED*) echo "logcat -> $LOG on $S (pid ${out##*STARTED })" ;;
      *) die "logcat did not start on the phone: $out" ;;
    esac
    ;;

  log-pull)
    DIR=${1:?usage: android.sh <serial> log-pull <dir>}
    mkdir -p "$DIR"
    chmod 700 "$DIR"
    files=$(adb -s "$S" shell "$DEV_OWNS; mark && ls \$l \$l.* 2>/dev/null" | tr -d '\r')
    case $files in *BADMARK*|*STARTING*) die "$PIDF on $S does not name a log of ours yet" ;; esac
    [ -n "$files" ] || die "no log of ours on the phone; run log-start first"
    for f in $files; do
      adb -s "$S" pull "$f" "$DIR/" >/dev/null
      chmod 600 "$DIR/$(basename "$f")"
      echo "$DIR/$(basename "$f")"
    done
    ;;

  log-stop)
    # Kills only the process the marker names (pid and start time), while it is our
    # logcat; deletes only the files the marker names, once nothing of it runs.
    out=$(adb -s "$S" shell "$DEV_OWNS; mark || { echo NOMARKER; exit 0; }; if owns \$p \$s \$l; then kill \$p 2>/dev/null; i=0; while ! gone \$p \$s && [ \$i -lt 5 ]; do sleep 1; i=\$((i + 1)); done; if ! gone \$p \$s; then echo FAILKILL \$p; exit 0; fi; elif ! gone \$p \$s; then echo FOREIGN \$p; exit 0; fi; rm -f $PIDF \$l \$l.*; echo STOPPED \$l") || die "adb shell failed on $S"
    case $out in
      *NOMARKER*) echo "no logcat marker on $S: nothing stopped, nothing deleted" ;;
      *STARTING*) die "a log-start is starting on $S; nothing stopped, nothing deleted" ;;
      *BADMARK*) die "$PIDF on $S does not name a log of ours; left alone" ;;
      *FAILKILL*) die "logcat ${out##*FAILKILL } did not stop; marker and log kept" ;;
      *FOREIGN*) die "pid ${out##*FOREIGN } on $S is not our logcat, or not known to be gone; marker and log kept" ;;
      *STOPPED*) echo "logcat stopped; ${out##*STOPPED } deleted on $S" ;;
      *) die "unexpected answer from $S: $out" ;;
    esac
    ;;

  stop)
    if [ ! -f "$MARK" ]; then
      echo "no forward of ours on $S for tcp:$PORT"
    elif ! list=$(adb -s "$S" forward --list); then
      die "adb forward --list failed on $S; the marker is kept"
    elif printf '%s\n' "$list" | grep -qxF "$S $(cat "$MARK")"; then
      adb -s "$S" forward --remove "tcp:$PORT"
      rm -f "$MARK"
      echo "removed the forward tcp:$PORT on $S"
    else
      rm -f "$MARK"
      echo "tcp:$PORT on $S is no longer our forward; left alone"
    fi
    ;;

  *) die "unknown command: $CMD" ;;
esac
