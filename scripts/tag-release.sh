#!/usr/bin/env bash
# tag-release.sh — Create and push an annotated git tag for a BridgeCam release.
#
# Usage:
#   ./scripts/tag-release.sh <version>
#
# Arguments:
#   version   Semver version string (e.g. 1.0.1)
#
# What it does:
#   1. Validates the version argument against semver format (MAJOR.MINOR.PATCH).
#   2. Creates an annotated git tag:  git tag -a v<version> -m "Release v<version>"
#   3. Pushes the tag to origin:      git push origin v<version>
#
# Requirements:
#   - Must be run from the repository root.
#   - Git remote 'origin' must exist and point to the BridgeCam repository.
#   - You should have network access to push to the remote.

set -euo pipefail

# --- Helpers ---

usage() {
    echo "Usage: $0 <version>"
    echo "  e.g.  $0 1.0.1"
    exit 1
}

validate_semver() {
    local version="$1"
    # Semver: MAJOR.MINOR.PATCH — each component is 1 or more digits
    if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 0
    else
        echo "Error: '$version' is not a valid semver version string." >&2
        echo "Expected format: MAJOR.MINOR.PATCH (e.g. 1.0.1)" >&2
        return 1
    fi
}

# --- Main ---

if [[ $# -ne 1 ]]; then
    usage
fi

VERSION="$1"
validate_semver "$VERSION"

TAG_NAME="v${VERSION}"

echo "==> Validated version: ${VERSION}"
echo "==> Creating annotated tag '${TAG_NAME}'..."
git tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"

echo "==> Pushing tag '${TAG_NAME}' to origin..."
git push origin "${TAG_NAME}"

echo ""
echo "Done. Tag '${TAG_NAME}' has been created and pushed."
echo "  Inspect:  git show ${TAG_NAME}"
echo "  Remove:  git tag -d ${TAG_NAME}  &&  git push origin --delete ${TAG_NAME}"
