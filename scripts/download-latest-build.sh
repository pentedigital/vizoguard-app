#!/bin/bash
# Downloads the latest signed Mac DMG + Windows EXE artifacts from GitHub
# Actions and copies them into the VPS downloads directory.
#
# Why this exists: the workflow's "deploy" job can't SCP from GitHub runners
# because Hostinger firewalls block GitHub IP ranges. So instead of pushing
# from the runner, the VPS pulls from the runner via `gh run download`. Run
# this on the VPS after a successful `Build & Deploy Vizoguard Desktop App`
# run completes.
#
# Prerequisites:
#   - `gh` CLI installed and authenticated (`gh auth status`)
#   - jq installed
#   - run as root (writes to /var/www/vizoguard/downloads/)
#
# Usage:
#   /root/vizoguard-app/scripts/download-latest-build.sh           # latest successful run
#   /root/vizoguard-app/scripts/download-latest-build.sh <RUN_ID>  # specific run
set -euo pipefail

DOWNLOADS=/var/www/vizoguard/downloads
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"

if [[ $# -ge 1 ]]; then
  RUN_ID="$1"
else
  RUN_ID=$(gh run list --repo pentedigital/vizoguard-app \
    --workflow build.yml --status success --limit 1 \
    --json databaseId --jq '.[0].databaseId')
fi

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "No successful build run found. Try: gh run list --repo pentedigital/vizoguard-app --workflow build.yml" >&2
  exit 1
fi

echo "Downloading artifacts from run $RUN_ID …"
gh run download "$RUN_ID" --repo pentedigital/vizoguard-app -n mac-dmg -D mac/
gh run download "$RUN_ID" --repo pentedigital/vizoguard-app -n win-exe -D win/

VERSION=$(grep '^version:' mac/latest-mac.yml | awk '{print $2}')
echo "Version: $VERSION"

# Mac DMGs
[[ -f mac/Vizoguard-${VERSION}.dmg ]]       && cp mac/Vizoguard-${VERSION}.dmg       "$DOWNLOADS/"
[[ -f mac/Vizoguard-${VERSION}-arm64.dmg ]] && cp mac/Vizoguard-${VERSION}-arm64.dmg "$DOWNLOADS/"

# Auto-update manifests
cp mac/latest-mac.yml "$DOWNLOADS/"
cp win/latest.yml     "$DOWNLOADS/"

# Windows EXE (preserve the spaces in filename so latest.yml matches)
WIN_EXE=$(ls win/*.exe | head -1)
cp "$WIN_EXE" "$DOWNLOADS/Vizoguard Setup ${VERSION}.exe"

# Update latest-* symlinks
cd "$DOWNLOADS"
ln -sf "Vizoguard-${VERSION}.dmg"          "Vizoguard-latest.dmg"
[[ -f "Vizoguard-${VERSION}-arm64.dmg" ]] && \
  ln -sf "Vizoguard-${VERSION}-arm64.dmg"  "Vizoguard-latest-arm64.dmg"
ln -sf "Vizoguard Setup ${VERSION}.exe"    "Vizoguard-latest.exe"

echo
echo "Deployed:"
ls -lh "$DOWNLOADS/Vizoguard-latest"* "$DOWNLOADS/latest-"*.yml
echo
echo "Live URLs:"
echo "  https://vizoguard.com/downloads/Vizoguard-latest.dmg"
echo "  https://vizoguard.com/downloads/Vizoguard-latest-arm64.dmg"
echo "  https://vizoguard.com/downloads/Vizoguard-latest.exe"
