#!/bin/sh
# Render one frame of a cached live scene with the CURRENT runtime/scene.tsx, headless (no app needed).
#   scripts/try-live.sh <cache live dir> <out.png> [frame] [keys,comma,separated]
# keys orbit the camera (ArrowRight x frames), e.g.  scripts/try-live.sh ~/Library/Caches/org.lanthorn/live/rt7-s1-110l1t7-cut /tmp/a.png 60 ArrowRight
set -e
SRC=$1; OUT=$2; FRAME=${3:-5}; KEYS=${4:-}
# never copy from an empty or wrong directory (an empty $SRC once meant "/.": the whole disk)
[ -n "$SRC" ] && [ -f "$SRC/scene.json" ] || { echo "try-live: no scene.json in '$SRC'" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
cp -R "$SRC/." "$W/"
cp "${RT:-$HERE/runtime/scene.tsx}" "$W/scene.tsx"
rm -f "$W/scene.comp.js" "$W/ok"
# STYLE=storybook|cartoon|dream|noir|pixel|cinematic: render in that look
if [ -n "$STYLE" ]; then python3 - "$W/scene.json" "$STYLE" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['style']=sys.argv[2]; json.dump(d,open(p,'w'))
PY
fi
# STAGE='[{"k":"creature",...}]': replace the scene's stage cues (JSON, as in a resolved scene)
if [ -n "$STAGE" ]; then python3 - "$W/scene.json" "$STAGE" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['stage']=json.loads(sys.argv[2]); json.dump(d,open(p,'w'))
PY
fi
# FIG='{"pose":"standing","onMachine":false,"x":0,"z":1,"acts":[...]}': merge into the first figure (to test acting)
if [ -n "$FIG" ]; then python3 - "$W/scene.json" "$FIG" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['figures'][0].update(json.loads(sys.argv[2])); json.dump(d,open(p,'w'))
PY
fi
# CAM="fx,fy,fz,tx,ty,tz": put the free camera at f looking at t (close-ups)
if [ -n "$CAM" ]; then python3 - "$W/scene.json" "$CAM" <<'PY'
import json,sys
p,c=sys.argv[1],[float(x) for x in sys.argv[2].split(',')]
d=json.load(open(p)); d['camera']['from']=c[:3]; d['camera']['lookFrom']=c[3:]; d['camera']['to']=c[3:]; d['shots']=[]
json.dump(d,open(p,'w'))
PY
fi
(cd "$W" && raea bundle scene.tsx --composition-bundle -o scene.comp.js >/dev/null)
SIZE=$(python3 -c "import json;print(*json.load(open('$W/scene.json'))['size'])")
"$HOME/sites/raea/target/release/lanthorn-world" --once "$W/scene.comp.js" "$W" $SIZE "$OUT" "$FRAME" "$KEYS" 2>&1 | grep -E "wrote|rror" || true
rm -rf "$W"
