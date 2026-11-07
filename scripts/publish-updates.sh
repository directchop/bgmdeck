#!/usr/bin/env bash
# Copy a GitHub Release's installers, .sig files and latest.json into the R2
# bucket behind the update feed worker (updates-worker/).
#
#   scripts/publish-updates.sh v0.6.1            # stable channel
#   scripts/publish-updates.sh v0.7.0-beta.1 beta
#
# Needs `gh` (release read) and `wrangler` (R2 write: `wrangler login`, or
# CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment, as in CI).
set -euo pipefail

TAG="${1:?usage: publish-updates.sh <tag> [stable|beta]}"
CHANNEL="${2:-stable}"
REPO="${REPO:-directchop/bgmdeck}"
BUCKET="${BUCKET:-bgmdeck-updates}"
VERSION="${TAG#v}"
case "$CHANNEL" in stable|beta) ;; *) echo "channel must be stable or beta" >&2; exit 2;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Downloading $TAG assets from $REPO..."
gh release download "$TAG" -R "$REPO" -D "$WORK" --pattern '*'

[ -f "$WORK/latest.json" ] || { echo "latest.json missing in $TAG (updater artifacts not built?)" >&2; exit 1; }
MANIFEST_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WORK/latest.json")"
[ "$MANIFEST_VERSION" = "$VERSION" ] || { echo "latest.json says $MANIFEST_VERSION but tag is $VERSION" >&2; exit 1; }

put() { # key file
  npx -y wrangler@4 r2 object put "$BUCKET/$1" --file "$2" --remote >/dev/null
  echo "  $1"
}

echo "Uploading to r2://$BUCKET/releases/$VERSION/"
for f in "$WORK"/*; do
  name="$(basename "$f")"
  [ "$name" = "latest.json" ] && continue
  put "releases/$VERSION/$name" "$f"
done
put "releases/$VERSION/latest.json" "$WORK/latest.json"
# The channel pointer goes last so clients never see a manifest whose files
# are still uploading.
put "manifest/$CHANNEL.json" "$WORK/latest.json"
echo "Published $VERSION to channel '$CHANNEL'."
