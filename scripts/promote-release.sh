#!/usr/bin/env bash
# Promote a tested pre-release to the latest release and redeploy the site.
#
#   scripts/promote-release.sh 1.16.0 [--dry-run]
#
# Only promotes a release that is currently a pre-release and whose build
# uploaded its assets (latest.json, SHA256SUMS and the Windows MSI), so an
# empty or half-built release can never become what the updater sees.
set -euo pipefail

usage() { echo "usage: $0 X.Y.Z [--dry-run]" >&2; exit 2; }
[ $# -ge 1 ] || usage
VERSION="$1"; shift
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z" >&2; exit 2; }
TAG="v$VERSION"
fail() { echo "error: $*" >&2; exit 1; }

info=$(gh release view "$TAG" --json isPrerelease,isDraft,assets) || fail "release $TAG not found"
[ "$(jq -r .isDraft <<<"$info")" = "false" ] || fail "$TAG is a draft"
[ "$(jq -r .isPrerelease <<<"$info")" = "true" ] || fail "$TAG is not a pre-release (already promoted?)"
for want in latest.json SHA256SUMS "ezTerm_${VERSION}_x64_en-US.msi"; do
  jq -e --arg n "$want" '.assets | any(.name == $n)' <<<"$info" >/dev/null \
    || fail "$TAG is missing asset $want — has the release build finished?"
done

for cmd in "gh release edit $TAG --prerelease=false --latest" "gh workflow run site.yml --ref main"; do
  echo "+ $cmd"
  [ "$DRY" -eq 1 ] || $cmd
done
[ "$DRY" -eq 1 ] && { echo "dry run: nothing changed"; exit 0; }
echo "ok: $TAG is now the latest release; the updater offers it and the site is redeploying."
