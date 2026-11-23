#!/usr/bin/env bash
# Signs the macOS bundles in a folder. With an Apple Developer ID (the
# MACOS_* / APPLE_* secrets below set in the repository's Actions secrets),
# it signs with the hardened runtime, notarises with Apple and staples the
# ticket, so the downloads open with no Gatekeeper warning. Without them it
# falls back to an ad-hoc signature, which still needs `xattr -cr` on the Mac.
#
#   MACOS_CERTIFICATE_P12      base64 of the exported "Developer ID Application" .p12
#   MACOS_CERTIFICATE_PASSWORD password of that .p12
#   APPLE_ID                   Apple ID email used for notarisation
#   APPLE_APP_PASSWORD         app-specific password for that Apple ID
#   APPLE_TEAM_ID              10-character team id
#
# Usage: sign-macos.sh <folder containing the .app/.vst3/.component>
set -euo pipefail
DIR="$1"
BUNDLES=("$DIR"/*.app "$DIR"/*.vst3 "$DIR"/*.component)

if [ -z "${MACOS_CERTIFICATE_P12:-}" ]; then
  echo "No Developer ID configured: ad-hoc signing (users must clear the quarantine flag)."
  for b in "${BUNDLES[@]}"; do codesign --force --deep --sign - "$b"; done
  echo "signed=adhoc" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
echo "$MACOS_CERTIFICATE_P12" | base64 --decode > "$RUNNER_TEMP/cert.p12"
security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
rm "$RUNNER_TEMP/cert.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)".*/\1/')"
if [ -z "$IDENTITY" ]; then
  echo "::error::The certificate is not a 'Developer ID Application' certificate."
  exit 1
fi

for b in "${BUNDLES[@]}"; do
  codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$b"
  codesign --verify --deep --strict "$b"
done

# Notarise all three in one submission, then staple each.
ditto -c -k --keepParent "$DIR" "$RUNNER_TEMP/notarize.zip"
xcrun notarytool submit "$RUNNER_TEMP/notarize.zip" \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait --timeout 30m
for b in "${BUNDLES[@]}"; do xcrun stapler staple "$b"; done
echo "signed=notarized" >> "${GITHUB_OUTPUT:-/dev/null}"
