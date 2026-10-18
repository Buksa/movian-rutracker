# Shared by start.sh and stop.sh; sourced, not run.

# A process that has exited but not been reaped yet is a zombie: it still has
# a PID, so kill -0 would call it alive.
alive() {
  kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]
}

# Stops PID $1 only if its command line contains the fixed text $2: a PID
# file can outlive its process, and the number may now belong to someone
# else. SIGTERM, up to 10 s for the process to exit, then SIGKILL. Returns 1
# when the process still runs after that.
stop_pid() {
  pid=$1
  tr '\0' ' ' 2>/dev/null < "/proc/$pid/cmdline" | grep -qF -- "$2" || return 0
  kill "$pid" 2>/dev/null
  i=0
  while alive "$pid" && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
  alive "$pid" || return 0
  kill -9 "$pid" 2>/dev/null
  i=0
  while alive "$pid" && [ $i -lt 3 ]; do sleep 1; i=$((i + 1)); done
  ! alive "$pid"
}
