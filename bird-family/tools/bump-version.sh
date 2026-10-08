#!/usr/bin/env bash
# Stamp a fresh version on the stylesheet and script links in index.html so
# browsers and CDNs fetch the new files instead of a cached copy.
# Run this after editing style.css, app.js or config.js:
#     ./tools/bump-version.sh
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(date +%Y%m%d%H%M)
sed -i.bak -E "s#(style\.css|app\.js|config\.js)(\?v=[0-9]+)?\"#\1?v=${V}\"#g" index.html
rm -f index.html.bak
grep -n "?v=" index.html
