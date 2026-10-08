#!/usr/bin/env bash
# Package the site for upload to any web host.
#
#   ./tools/make-zip.sh            -> supportthebirdfamily-site.zip next to this folder
#
# The zip contains only what the server needs (no tools/, no git files).
# Unzip it into the host's public_html / www root and the site is live.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="supportthebirdfamily-site"
OUT="../${NAME}.zip"
rm -f "$OUT"
zip -r -X "$OUT" index.html style.css app.js config.js assets qr \
  -x '*.DS_Store' -x '__MACOSX/*'
echo
echo "Wrote $(cd .. && pwd)/${NAME}.zip"
unzip -l "$OUT"
