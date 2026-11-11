#!/bin/bash
# Runs INSIDE the graphite-configuration container (started by mdt build/package).
#
# Same steps the MAS configuration tool runs (graphite-tools.js build:production
# + upload): yarn labels -> maxdev-cli build -> graphite-cli build ->
# maxdev-cli package-app -v <app.xml version>, plus an optional framework overlay.
#
# Mounts: /src (app sources, ro)  /mdt (tool, ro)  /out (results, rw)
#         /framework + /baseline (optional, ro)
# Env:    MDT_DEBUG=1      unminified bundle + external source maps
#         MDT_FRAMEWORK=0  build with the stock framework from the image
#         VITE_*           passed through into the app's process.env
#
# Output in /out:
#   <app>__ver-<version>.zip   the app binary Maximo serves to devices
#   app-source.zip             project sources (what is inside the binary)
#   <app>.zip                  sources in the Configuration app upload layout (<app>/...)
#   www/                       the binary unpacked (what lands on the device)
#   mdt-build.json, framework-report.json
set -euo pipefail

W=/graphite/.workspace/mdt/app
log() { echo "[mdt] $*"; }
ver() { node -p "require('/graphite/node_modules/@maximo/$1/package.json').version"; }

log "node $(node --version), maximo-js-api $(ver maximo-js-api), maxdev-cli $(ver maxdev-cli), graphite-cli $(ver graphite-cli)"
mkdir -p "$W"
rm -rf /out/www /out/generated /out/*.zip /out/framework-report.json /out/mdt-build.json
tar -C /src --exclude=./.git --exclude=./build --exclude=./node_modules --exclude=./coverage -cf - . | tar -C "$W" -xf -

if [ "${MDT_FRAMEWORK:-1}" = "1" ] && [ -f /baseline/manifest.json ] && [ -d /framework ]; then
  node /mdt/container/compile-framework.cjs --framework /framework --baseline /baseline --apply --report /out/framework-report.json
else
  log "framework overlay: off (stock framework from the image)"
fi

cd "$W"
if node -e 'process.exit(require("./package.json").scripts?.labels ? 0 : 1)' 2>/dev/null; then
  log "labels"
  yarn -s labels
fi

export GRAPHITE_TOOLS=1 PUBLIC_URL=./
if [ "${MDT_DEBUG:-0}" != "1" ]; then
  # graphite-tools build:production sets these for maxdev-cli AND graphite-cli
  export CI=true GRAPHITE_RELEASE=true
fi
log "maxdev-cli build"
npx --no-install maxdev-cli build --in ./src/app.xml --out ./build/app/src/ --update-ids --copy

if [ "${MDT_DEBUG:-0}" = "1" ]; then
  # the React code app.xml turned into: shows which framework components/props each tag uses
  rm -rf /out/generated && mkdir -p /out/generated && cp -r build/app/src/. /out/generated/
fi

cd build/app
if [ "${MDT_DEBUG:-0}" = "1" ]; then
  log "graphite-cli build (debug: unminified, source maps)"
  GRAPHITE_SOURCEMAP=true GRAPHITE_MINIFY=false npx --no-install graphite-cli build
else
  log "graphite-cli build (release, same as the configuration tool)"
  npx --no-install graphite-cli build
fi
cd "$W"

# the config tool's upload passes the raw app.xml version (e.g. 9.2.71.0)
APPID=$(node -p 'require("@maximo/maxdev-cli/src/lib/Utils").readAppData("src/app.xml").id')
APPVER=$(node -p 'require("@maximo/maxdev-cli/src/lib/Utils").readAppData("src/app.xml").version')
log "package-app -a $APPID -v $APPVER"
npx --no-install maxdev-cli package-app -a "$APPID" -v "$APPVER" --skip-backup-xmls

ZIP="build/app/build/${APPID}__ver-${APPVER}.zip"
[ -f "$ZIP" ] || { echo "[mdt] package-app did not create $ZIP"; exit 1; }
mkdir -p /out/www
cp "$ZIP" /out/
# unpack inside the container first: a Windows-mounted /out refuses chmod/utime
rm -rf /tmp/www && unzip -q -o -d /tmp/www "$ZIP" && cp -r /tmp/www/. /out/www/
cp /tmp/www/app-source.zip /out/app-source.zip
rm -rf /tmp/cfgzip && mkdir -p "/tmp/cfgzip/$APPID" && unzip -q -o -d "/tmp/cfgzip/$APPID" /tmp/www/app-source.zip
(cd /tmp/cfgzip && zip -q -r "/tmp/$APPID.zip" "$APPID") && cp "/tmp/$APPID.zip" "/out/$APPID.zip"

node -e '
const fs = require("fs");
const b = JSON.parse(fs.readFileSync("/tmp/www/build.json", "utf8"));
let fw = null;
try { fw = JSON.parse(fs.readFileSync("/out/framework-report.json", "utf8")); } catch (e) {}
fs.writeFileSync("/out/mdt-build.json", JSON.stringify({
  appId: process.argv[1], version: process.argv[2], zip: require("path").basename(process.argv[3]),
  buildJsonVersion: b.version, debug: process.env.MDT_DEBUG === "1", builtAt: new Date().toISOString(),
  appProcessorVersion: b.appProcessorVersion, buildToolsVersion: b.buildToolsVersion,
  framework: fw ? {changed: fw.changed, added: fw.added} : null
}, null, 1));
' "$APPID" "$APPVER" "$ZIP"
log "done: $(basename "$ZIP")"
