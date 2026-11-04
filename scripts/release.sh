#!/usr/bin/env bash
# Create an ezTerm release AS A PRE-RELEASE.
#
#   scripts/release.sh 1.16.0 [--dry-run]
#
# The release is created with `--prerelease` in the same API call that
# creates it, so it is never visible as a normal / latest release — not
# even for a moment. (It is NOT created normally and flipped afterwards.)
# The in-app updater and the website's /dl/ MSI follow GitHub's *latest*
# release, which excludes pre-releases, so nothing reaches users until
# `scripts/promote-release.sh` is run after testing.
#
# Refuses to run unless: on an up-to-date, clean `main`; the three version
# files all say X.Y.Z; docs/release-notes/vX.Y.Z.md exists; the tag and
# release don't exist yet. Afterwards it verifies GitHub reports the new
# release as a pre-release (and not a draft).
set -euo pipefail

usage() { echo "usage: $0 X.Y.Z [--dry-run]" >&2; exit 2; }
[ $# -ge 1 ] || usage
VERSION="$1"; shift
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'" >&2; exit 2; }
TAG="v$VERSION"
NOTES="docs/release-notes/$TAG.md"

cd "$(git rev-parse --show-toplevel)"
fail() { echo "error: $*" >&2; exit 1; }

[ "$(git branch --show-current)" = "main" ] || fail "not on main"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not in sync with origin/main (push or pull first)"

cargo_v=$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -n 1)
tauri_v=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json | head -n 1)
ui_v=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ui/package.json | head -n 1)
for pair in "Cargo.toml:$cargo_v" "src-tauri/tauri.conf.json:$tauri_v" "ui/package.json:$ui_v"; do
  [ "${pair#*:}" = "$VERSION" ] || fail "${pair%%:*} has version '${pair#*:}', expected $VERSION"
done
[ -f "$NOTES" ] || fail "missing release notes: $NOTES"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "tag $TAG already exists on origin"
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  fail "release $TAG already exists"
fi

CMD=(gh release create "$TAG" --target main --prerelease
     --title "ezTerm $TAG" --notes-file "$NOTES")
echo "+ ${CMD[*]}"
if [ "$DRY" -eq 1 ]; then
  echo "dry run: nothing created"
  exit 0
fi
"${CMD[@]}"

state=$(gh release view "$TAG" --json isPrerelease,isDraft --jq '"\(.isPrerelease) \(.isDraft)"')
[ "$state" = "true false" ] || fail "GitHub reports $TAG as isPrerelease/isDraft = '$state' — check it by hand"
echo "ok: $TAG created as a pre-release. The release workflow is building it."
echo "Test it, then run: scripts/promote-release.sh $VERSION"
