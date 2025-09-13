# BGM Deck

This project (README and implementation) was created with Codex (Codex CLI).

A 10-slot BGM player built with Rust + eframe/egui and rodio. Assign mp3/wav files per slot, play with a click, crossfade between slots, switch output devices, and persist all settings.

## Features
- 10 slots: assign mp3/wav via drag-and-drop or file dialog
- Per-slot volume: 0.0–1.0 saved per slot
- Output device selection: powered by `cpal/rodio`
- Crossfade: linear with 20ms steps using `Sink::set_volume()`; old sink `stop()` after fade
- Persistence: file paths, per-slot volume, output device name, crossfade seconds, master volume, slot names, and per‑slot looping via `confy`
- macOS bundle: `.app` build, optional codesign/notarization, and DMG packaging via CI

## Requirements
- macOS (Intel/Apple Silicon)
- Rust stable (≈1.70+)
- Xcode Command Line Tools may be required: `xcode-select --install`

## Setup
```bash
# If Rust is not installed
brew install rustup-init && rustup-init -y
source "$HOME/.cargo/env"

# Clone & run
git clone git@github.com:directchop/bgmdeck.git
cd bgmdeck/bgm_deck
cargo run
```

## Usage
- Drop mp3/wav onto a slot or click “Open…” to assign
- Click “Play” to start; pressing a different slot’s “Play” crossfades to it
- Adjust “CrossFade (sec)” at the top (auto-saved)
- Select “Output Device” to change audio output (stops current sink and rebinds stream)
- Long paths show filename only; hover to see the full path
- Active slot is highlighted
- Per-slot “Loop” checkbox (default on)

### Shortcuts
- `1`–`9`: play slot 1–9
- `0`: stop playback
- While typing in a text field, shortcuts are disabled

## Project Layout
- `bgm_deck/Cargo.toml`: dependencies and bundle metadata (identifier: `com.atelierworks.bgmdeck`)
- `bgm_deck/src/main.rs`: the entire app in one file
- `bgm_deck/Makefile`: bundle/sign/notarize pipeline for local macOS builds
- `.github/workflows/macos-release.yml`: CI to build/upload ZIP and DMG (unsigned by default; signs/notarizes if secrets exist)

## macOS App Bundle
Build the `.app` with `cargo-bundle`:
```bash
cd bgm_deck
cargo install cargo-bundle
cargo bundle --release
# Output: target/release/bundle/osx/BGM\ Deck.app
open "target/release/bundle/osx/BGM Deck.app"
```

## Release (CI)
Pushing a tag `v*` triggers the GitHub Actions workflow which:
1) Builds the `.app`
2) Creates a ZIP and a DMG
3) Uploads them as artifacts and release assets

By default (no secrets), releases are unsigned. Users must allow the first run via System Settings → Privacy & Security, or right-click Open.

### Optional: Codesign & Notarize
Set these repository secrets to enable signing and notarization:
- `CODE_SIGN_IDENTITY` (e.g., `Developer ID Application: AtelierWorks Inc. (ABCDE12345)`)
- `DEVELOPER_ID_APP_CERT_P12` (base64 of your `.p12`)
- `DEVELOPER_ID_APP_CERT_PASSWORD`
- `AC_API_KEY_ID`, `AC_API_ISSUER_ID`, `AC_API_PRIVATE_KEY` (App Store Connect API key `.p8` content)

Tag example:
```bash
git tag v0.1.1
git push origin v0.1.1
```

## Local signed build (optional)
```bash
cd bgm_deck
export DEVELOPER_ID_APP="Developer ID Application: AtelierWorks Inc. (ABCDE12345)"
export NOTARY_PROFILE="atelierworks-notary"  # saved via `xcrun notarytool store-credentials`
export BUILD_NUMBER=42
make bundle-signed
# Outputs:
#  - target/release/bundle/osx/BGM Deck.app (stapled if secrets/profile available)
#  - target/release/BGM Deck.zip
```

## Troubleshooting
- Xcode errors: run `xcode-select --install`
- No sound: try changing the Output Device (virtual devices or mismatched sample rates can be problematic)
- mp3 won’t load: most mp3s should work via rodio/symphonia; corrupt files will fail
- Blank window: rare GPU issues; run with `RUST_BACKTRACE=1 cargo run` to inspect logs
- Gatekeeper prompt (unsigned builds): right‑click → Open, or allow under Privacy & Security

## Roadmap Ideas
- Playback position/seek and loop controls
- More hotkeys and optional global shortcuts
- Multiple profiles (setlists)
- Custom mixer with `cpal` (simultaneous playback, advanced fades)

## License
TBD
