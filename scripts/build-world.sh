#!/bin/sh
# Build lanthorn-world inside a raea checkout (it needs raea's workspace: its vendored patches and lockfile).
#   scripts/build-world.sh [--stage] [path/to/raea]        default ~/sites/raea
# Needs: Rust, cmake. Output: <raea>/target/release/liblanthorn_world.dylib (and the lanthorn-world test binary).
# --stage also copies a stripped dylib to src-tauri/world/, where `tauri build --config src-tauri/tauri.release.conf.json`
# bundles it into the app (npm run bundle does both).
set -e
STAGE=0; [ "$1" = "--stage" ] && { STAGE=1; shift; }
RAEA=${1:-$HOME/sites/raea}
HERE=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$RAEA/lanthorn-world" && mkdir -p "$RAEA/lanthorn-world"
cp -R "$HERE/world/Cargo.toml" "$HERE/world/src" "$RAEA/lanthorn-world/"
grep -q '"lanthorn-world"' "$RAEA/Cargo.toml" || sed -i '' 's|^members = \[|members = [\n  "lanthorn-world",|' "$RAEA/Cargo.toml"
cd "$RAEA" && RAEA_BUNDLE_SKIP=1 cargo build --release -p lanthorn-world
echo "built: $RAEA/target/release/lanthorn-world"

if [ "$STAGE" = 1 ]; then
  OUT="$HERE/src-tauri/world"; mkdir -p "$OUT"
  cp "$RAEA/target/release/liblanthorn_world.dylib" "$OUT/liblanthorn_world.dylib"
  strip -x "$OUT/liblanthorn_world.dylib"   # local symbols and debug info: ~268 MB -> ~140 MB, exports (lw_*) stay
  # the dylib's install name must not point into the build tree
  install_name_tool -id @rpath/liblanthorn_world.dylib "$OUT/liblanthorn_world.dylib" 2>/dev/null || true
  codesign --force --sign - "$OUT/liblanthorn_world.dylib" 2>/dev/null || true   # ad hoc; a release build signs the whole app
  ls -lh "$OUT/liblanthorn_world.dylib"
fi
