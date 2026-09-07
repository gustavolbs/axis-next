#!/bin/bash

# Creates the stable self-signed code-signing identity used by Axis releases.
#
# Squirrel.Mac (through electron-updater) validates a downloaded update against
# the designated requirement of the running app. An ad-hoc signature pins that
# requirement to a per-build cdhash, so every release would reject its successor.
# A certificate — even a self-signed one — produces a certificate-pinned
# requirement that stays stable across releases.
#
# This buys automatic updates, not Gatekeeper trust: first installs still need
# the usual right-click -> Open. Notarization requires a paid Apple Developer ID.

set -euo pipefail

OUT_DIR="${1:-$HOME/axis-signing}"
CN="Axis Code Signing"
ORG="Axis"
DAYS=7300
REPO="gustavolbs/axis-next"

if [ "$(uname)" != "Darwin" ]; then
  echo "Run this script on macOS." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

KEY="$OUT_DIR/axis-code-signing.key"
CRT="$OUT_DIR/axis-code-signing.crt"
P12="$OUT_DIR/axis-code-signing.p12"

if [ -e "$KEY" ] || [ -e "$CRT" ] || [ -e "$P12" ]; then
  echo "Refusing to overwrite an existing Axis signing identity in $OUT_DIR." >&2
  echo "Rotating this certificate breaks automatic updates for installed copies." >&2
  exit 1
fi

OPENSSL=/usr/bin/openssl
if [ -x /opt/homebrew/bin/openssl ]; then
  OPENSSL=/opt/homebrew/bin/openssl
fi

read -r -s -p "Choose a strong password for the Axis .p12: " P12_PASS
echo
if [ -z "$P12_PASS" ]; then
  echo "A password is required." >&2
  exit 1
fi

echo "Creating $CN..."
"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$KEY" \
  -out "$CRT" \
  -subj "/CN=$CN/O=$ORG" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

if "$OPENSSL" pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
  "$OPENSSL" pkcs12 -export -legacy \
    -out "$P12" \
    -inkey "$KEY" \
    -in "$CRT" \
    -name "$CN" \
    -passout "pass:$P12_PASS"
else
  "$OPENSSL" pkcs12 -export \
    -out "$P12" \
    -inkey "$KEY" \
    -in "$CRT" \
    -name "$CN" \
    -passout "pass:$P12_PASS"
fi

chmod 600 "$KEY" "$P12"

# Confirm macOS can parse the PKCS#12 without touching the login keychain. The
# release runner performs the actual code-signing check.
VERIFY_KEYCHAIN="$OUT_DIR/.axis-signing-verify.keychain-db"
security delete-keychain "$VERIFY_KEYCHAIN" >/dev/null 2>&1 || true
security create-keychain -p verify "$VERIFY_KEYCHAIN" >/dev/null
security unlock-keychain -p verify "$VERIFY_KEYCHAIN" >/dev/null
security import "$P12" -k "$VERIFY_KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
security delete-keychain "$VERIFY_KEYCHAIN" >/dev/null

echo
echo "Created: $P12"
echo "Back up this file and its password somewhere durable. Do not commit either."
echo
echo "Configure the repository secrets with:"
echo "  base64 -i '$P12' | gh secret set MAC_CSC_LINK --repo $REPO"
echo "  gh secret set MAC_CSC_KEY_PASSWORD --repo $REPO"
echo
echo "Use the same password you entered above for MAC_CSC_KEY_PASSWORD."
