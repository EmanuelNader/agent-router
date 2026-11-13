#!/bin/sh
# Install pinned restic 0.19.1. The checksums are from the upstream SHA256SUMS for that release.
set -eu
VERSION=0.19.1
DEST="${1:-$HOME/.local/bin/restic}"
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS:$ARCH" in
  Linux:x86_64) ASSET=linux_amd64; SHA=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c ;;
  Linux:aarch64|Linux:arm64) ASSET=linux_arm64; SHA=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465 ;;
  Darwin:x86_64) ASSET=darwin_amd64; SHA=c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35 ;;
  Darwin:arm64) ASSET=darwin_arm64; SHA=7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143 ;;
  *) echo "Unsupported restic platform: $OS $ARCH" >&2; exit 1 ;;
esac
if "$DEST" version 2>/dev/null | grep -q "restic $VERSION "; then
  exit 0
fi
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL -o "$TMP" "https://github.com/restic/restic/releases/download/v${VERSION}/restic_${VERSION}_${ASSET}.bz2"
if command -v sha256sum >/dev/null 2>&1; then echo "$SHA  $TMP" | sha256sum -c -; else echo "$SHA  $TMP" | shasum -a 256 -c -; fi
mkdir -p "$(dirname "$DEST")"
bunzip2 -c "$TMP" > "$DEST"
chmod 755 "$DEST"
"$DEST" version
