#!/bin/sh
# Builds the two installable archives into m7-cookie-bridge/dist/:
#   RuTracker.org-<version>-m7-bridge.zip        Movian plugin (plugin.json at the root)
#   movian-cookie-bridge-extension-<version>.zip  unpacked Chrome/Brave extension
# Versions come from plugin.json and extension/manifest.json.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST="$ROOT/m7-cookie-bridge/dist"
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }
PV=$(version "$ROOT/plugin.json")
EV=$(version "$ROOT/m7-cookie-bridge/extension/manifest.json")
mkdir -p "$DIST"
rm -f "$DIST/RuTracker.org-$PV-m7-bridge.zip" "$DIST/movian-cookie-bridge-extension-$EV.zip"
cd "$ROOT"
zip -qr -X "$DIST/RuTracker.org-$PV-m7-bridge.zip" plugin.json main.js logo.png src vendor
TMP=$(mktemp -d)
cp -r m7-cookie-bridge/extension "$TMP/movian-cookie-bridge-extension"
(cd "$TMP" && zip -qr -X "$DIST/movian-cookie-bridge-extension-$EV.zip" movian-cookie-bridge-extension)
rm -rf "$TMP"
echo "$DIST/RuTracker.org-$PV-m7-bridge.zip"
echo "$DIST/movian-cookie-bridge-extension-$EV.zip"
