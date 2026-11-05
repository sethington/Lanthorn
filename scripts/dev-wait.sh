#!/bin/sh
# Wait until the running dev app is newer than the last edit to src-tauri/ (or world dylib), and answers the debug bridge.
#   scripts/dev-wait.sh [max-seconds]     exit 0 when ready, 1 on timeout. Prints what it is waiting for every 5 s.
# macOS ps has no `etimes`; the process start time comes from `lstart`.
MAX=${1:-240}
cd "$(dirname "$0")/.." || exit 2
newest=$(find src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json -type f -exec stat -f %m {} + | sort -n | tail -1)
dylib=$(stat -f %m "$HOME/sites/raea/target/release/liblanthorn_world.dylib" 2>/dev/null || echo 0)
[ "$dylib" -gt "$newest" ] && newest=$dylib
t0=$(date +%s)
while :; do
  pid=$(pgrep -f 'target/debug/lanthorn' | head -1)
  if [ -n "$pid" ]; then
    start=$(date -j -f "%a %b %e %T %Y" "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null || echo 0)
    if [ "$start" -gt "$newest" ]; then
      marker=$(date +%s)
      curl -s -m 2 -X POST localhost:1420/__debug/cmd -d "ping:$marker" >/dev/null
      sleep 2.5
      grep -q "ping:$marker" .debug/app.log 2>/dev/null && { echo "ready: app started $((marker-start))s ago, newer than the last edit"; exit 0; }
      why="app is newer than the last edit; waiting for the page to answer the bridge"
    else
      why="app (pid $pid) started $(( $(date +%s)-start ))s ago, but src-tauri changed $(( $(date +%s)-newest ))s ago: rebuild pending"
    fi
  else
    why="no app process: compiling or starting"
  fi
  [ $(( $(date +%s)-t0 )) -ge "$MAX" ] && { echo "timeout: $why"; exit 1; }
  [ $(( ($(date +%s)-t0) % 5 )) -lt 2 ] && echo "waiting: $why"
  sleep 2
done
