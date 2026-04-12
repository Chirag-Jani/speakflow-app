#!/usr/bin/env bash
# Notarize a signed .app (requires Apple Developer Program).
# Prerequisites:
#   - App already signed with "Developer ID Application: ..." (not ad-hoc "-").
#   - xcrun notarytool, app-specific password or API key.
# Usage:
#   export APPLE_ID="you@email.com"
#   export APPLE_TEAM_ID="XXXXXXXXXX"
#   export NOTARY_PASSWORD="app-specific-password"
#   ./scripts/notarize-macos.sh path/to/SpeakFlow.app
set -euo pipefail
APP="${1:?Usage: $0 path/to/App.app}"
if [[ ! -d "$APP" ]]; then
  echo "Not found: $APP"
  exit 1
fi
ZIP="${APP%.app}.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --wait \
  --apple-id "${APPLE_ID:?set APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}" \
  --password "${NOTARY_PASSWORD:?set NOTARY_PASSWORD}"
xcrun stapler staple "$APP"
rm -f "$ZIP"
echo "Stapled notarization onto $APP"
