#!/usr/bin/env bash
# Builds Claude Code Manager (vishalguptax/claude-code-manager) from a local checkout
# and vendors the packaged files as a built-in extension of the terminal-first variant.
# Usage: ./dev/vendor-claude-manager.sh [path-to-checkout]
set -e

SRC="${1:-/c/dev/claude-code-manager}"
DST="src/terminal/extensions/claude-manager"

cd "${SRC}"
COMMIT=$( git rev-parse --short HEAD )
VERSION=$( jq -r '.version' package.json )
npx --yes pnpm@10 install --frozen-lockfile
npx --yes pnpm@10 run build
cd - > /dev/null

rm -rf "${DST}"
mkdir -p "${DST}/media"
cp -r "${SRC}/dist" "${DST}/dist"
find "${DST}/dist" -name '*.map' -delete
cp "${SRC}"/package.json "${SRC}"/readme.md "${SRC}"/changelog.md "${DST}/"
cp "${SRC}"/LICENSE* "${DST}/" 2>/dev/null || true
for file in "${SRC}"/media/*; do
  name=$( basename "${file}" )
  if [[ -f "${file}" && "${name}" != "demo.gif" && "${name}" != "marketplace-icon.svg" ]]; then
    cp "${file}" "${DST}/media/"
  fi
done

# activate at startup so the status bar chip and views are ready without a first click
jq '.activationEvents = ["onStartupFinished"]' "${DST}/package.json" > "${DST}/package.json.tmp"
mv "${DST}/package.json.tmp" "${DST}/package.json"

printf 'vendored from %s\ncommit %s\nversion %s\n' "${SRC}" "${COMMIT}" "${VERSION}" > "${DST}/VENDORED.txt"
du -sh "${DST}"
