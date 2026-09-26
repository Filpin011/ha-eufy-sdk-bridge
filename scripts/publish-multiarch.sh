#!/usr/bin/env bash
# Build and push the bridge image as a MULTI-ARCH manifest to GitHub Container Registry.
#
# Why this exists: the add-on (ha-eufy-sdk-addon) builds FROM this image on aarch64 / amd64, so a
# single-arch `docker build … && push` leaves ARM installs unable to resolve the base. `docker buildx
# --platform …` produces one manifest carrying both; the Dockerfile selects the go2rtc binary by
# TARGETARCH, so no per-arch edits are needed here. (node:24-alpine has no arm/v7 base, so 32-bit ARM
# is not built.)
#
# Prerequisites:
#   - Docker with buildx (Docker 20.10+).
#   - Logged in to ghcr.io:  echo "$GHCR_PAT" | docker login ghcr.io -u <user> --password-stdin
#     (the PAT needs `write:packages`.)
# The SDK is a public npm package pulled by `npm ci` inside the build — no sibling checkout / context.
#
# Usage:
#   scripts/publish-multiarch.sh              # version from package.json, tags :<version> + :latest
#   scripts/publish-multiarch.sh 0.1.36       # explicit version
#   PLATFORMS=linux/amd64,linux/arm64 scripts/publish-multiarch.sh   # override the platform set
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="ghcr.io/mega-yfue/ha-eufy-sdk-bridge"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
VERSION="${1:-$(node -p "require('./package.json').version")}"

# The SDK is a public npm package (@mega-yfue/eufy-sdk, pinned in package.json), pulled by `npm ci`
# inside the build — no sibling checkout or named build context needed.

# A dedicated builder so the host's default (often the docker driver, which can't do multi-platform)
# is left untouched. Reuse it across runs.
if ! docker buildx inspect eufy-multiarch >/dev/null 2>&1; then
  docker buildx create --name eufy-multiarch --driver docker-container >/dev/null
fi

echo "Building ${IMAGE}:${VERSION} (+ :latest) for ${PLATFORMS}"
docker buildx build \
  --builder eufy-multiarch \
  --platform "${PLATFORMS}" \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --push \
  .

echo "Pushed ${IMAGE}:${VERSION} and ${IMAGE}:latest"
echo "Verify:  docker buildx imagetools inspect ${IMAGE}:${VERSION}"
