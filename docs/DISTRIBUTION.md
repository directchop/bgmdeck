# Distribution

Same pipeline as playque. Pushing a `v*` tag runs `.github/workflows/release.yml`:
macOS arm64 / x86_64, Windows x64, Linux x64 → draft GitHub Release with
installers, updater bundles and `latest.json`.

## Repository secrets

Set these on `directchop/bgmdeck` (Settings → Secrets → Actions). They are
the same values as on playque; the updater key pair is shared on purpose so
one key signs both apps.

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater bundle signatures (public key in `tauri.conf.json`) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Developer ID signing + notarization |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Windows code signing (optional) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Lets CI publish to the update feed (optional; otherwise run the script by hand) |

From a machine where the playque values are in a `.env`-style file:

```bash
for s in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  gh secret set "$s" -R directchop/bgmdeck --body "${!s}"
done
```

Without the signing secrets the workflow still builds unsigned installers
(and no updater artifacts).

## Update feed

`updates-worker/` is the Cloudflare Worker that serves
`https://bgmdeck-updates.<account>.workers.dev/{target}/{arch}/{current_version}`
from an R2 bucket. One-time setup:

```bash
cd updates-worker
npx wrangler login
npx wrangler r2 bucket create bgmdeck-updates
npx wrangler deploy
```

If the deployed URL differs from the endpoint in `src-tauri/tauri.conf.json`,
change the endpoint before the first release that should auto-update.

## Release checklist

1. Bump the version in `package.json`, `package-lock.json`
   (`npm install --package-lock-only --ignore-scripts`), `src-tauri/Cargo.toml`
   (+ `cargo check` for `Cargo.lock`), `src-tauri/tauri.conf.json`; add a
   `CHANGELOG.md` entry.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` → wait for the four builds.
3. `scripts/publish-updates.sh vX.Y.Z` (copies assets + `latest.json` into R2
   and flips `manifest/stable.json`). Pre-release tags (`v1.0.0-beta.1`) go to
   the `beta` channel.
4. Verify: `curl -i https://bgmdeck-updates.<account>.workers.dev/darwin/aarch64/0.0.1`
   should answer 200 with the new version.
5. `gh release edit vX.Y.Z --draft=false --latest --notes-file <notes>`.
