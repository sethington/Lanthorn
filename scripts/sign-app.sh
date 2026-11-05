#!/bin/sh
# Sign a built Lanthorn.app (the world library inside it first, then the app).
#   scripts/sign-app.sh [path/to/Lanthorn.app]                  ad hoc: runs on this Mac only
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/sign-app.sh   for distribution
# Then notarise a distribution build:
#   ditto -c -k --keepParent Lanthorn.app Lanthorn.zip
#   xcrun notarytool submit Lanthorn.zip --keychain-profile <profile> --wait && xcrun stapler staple Lanthorn.app
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=${1:-$HERE/src-tauri/target/release/bundle/macos/Lanthorn.app}
ID=${APPLE_SIGNING_IDENTITY:--}
[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 2; }
LIB="$APP/Contents/Resources/world/liblanthorn_world.dylib"
[ -f "$LIB" ] || { echo "the world library isn't in the app: build with  npm run bundle" >&2; exit 2; }
if [ "$ID" = "-" ]; then OPTS=""; else OPTS="--options runtime --timestamp"; fi
codesign --force --sign "$ID" $OPTS "$LIB"
codesign --force --deep --sign "$ID" $OPTS --entitlements "$HERE/src-tauri/entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"
echo "signed ($( [ "$ID" = "-" ] && echo 'ad hoc' || echo "$ID" )): $APP"
