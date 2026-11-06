#!/bin/sh
# Screenshot the reader at a list of sentence positions (dev bridge; the window must be able to come to the front).
#   scripts/tour.sh OUTDIR PREFIX 10 55 120 ...
OUT=$1; PRE=$2; shift 2
mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
ID=$(swift "$HERE/winid.swift" 2>/dev/null)
front() { osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "lanthorn") to true' >/dev/null 2>&1; }
for s in "$@"; do
  curl -s -X POST localhost:1420/__debug/cmd -d "jump:$s" >/dev/null
  for k in 1 2 3 4 5 6 7; do front; sleep 3; done
  screencapture -x -o -l"$ID" "$OUT/${PRE}-$s.png"
done
