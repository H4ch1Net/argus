#!/usr/bin/env bash
# Fetch nodejs-mobile (Node 18 built as a shared library for Android,
# https://github.com/nodejs-mobile/nodejs-mobile) and stage libnode.so per ABI
# plus its headers in android/app/libnode/ for the Gradle build.
#
#   android/fetch-libnode.sh
#   NODEJS_MOBILE_SHA256=<sha256> android/fetch-libnode.sh    (verify; CI does)
#
# NODEJS_MOBILE_VERSION picks the release (default below). Without
# NODEJS_MOBILE_SHA256 the download is not verified and its checksum is printed
# so it can be pinned. The archive is cached in android/.cache/.

set -euo pipefail

VERSION="${NODEJS_MOBILE_VERSION:-18.20.4}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/app/libnode"
CACHE="${NODEJS_MOBILE_CACHE:-$HERE/.cache}"
NAME="nodejs-mobile-v${VERSION}-android.zip"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${VERSION}/${NAME}"
ZIP="$CACHE/$NAME"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$CACHE"
if [ ! -s "$ZIP" ]; then
  echo "[libnode] downloading $URL"
  curl -fL --retry 3 -o "$ZIP.part" "$URL"
  mv "$ZIP.part" "$ZIP"
fi

SUM="$(sha256 "$ZIP")"
if [ -n "${NODEJS_MOBILE_SHA256:-}" ]; then
  if [ "$SUM" != "$NODEJS_MOBILE_SHA256" ]; then
    echo "[libnode] checksum mismatch for $NAME" >&2
    echo "[libnode]   expected $NODEJS_MOBILE_SHA256" >&2
    echo "[libnode]   got      $SUM" >&2
    rm -f "$ZIP"
    exit 1
  fi
  echo "[libnode] sha256 verified: $SUM"
else
  echo "[libnode] WARNING: not verified. sha256 of $NAME is $SUM" >&2
  echo "[libnode] pin it as NODEJS_MOBILE_SHA256 (see .github/workflows/android.yml)" >&2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"

HEADER="$(find "$WORK" -type f -path '*/include/node/node.h' | head -n 1)"
if [ -z "$HEADER" ]; then
  echo "[libnode] include/node/node.h not found in $NAME" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/include" "$DEST/bin"
cp -R "$(dirname "$HEADER")" "$DEST/include/node"

found=0
for abi in arm64-v8a armeabi-v7a x86_64 x86; do
  so="$(find "$WORK" -type f -path "*/$abi/libnode.so" | head -n 1)"
  if [ -n "$so" ]; then
    mkdir -p "$DEST/bin/$abi"
    cp "$so" "$DEST/bin/$abi/libnode.so"
    found=$((found + 1))
    echo "[libnode] staged $abi ($(du -h "$DEST/bin/$abi/libnode.so" | cut -f1))"
  fi
done
if [ "$found" -eq 0 ]; then
  echo "[libnode] no libnode.so found in $NAME" >&2
  exit 1
fi
echo "[libnode] Node $VERSION ready in $DEST"
