# BGM Deck v0.1.0

A first public build of BGM Deck — a 10‑slot BGM player built with Rust + eframe/egui and rodio.

## Highlights
- 10 slots with drag‑and‑drop or file picker (mp3/wav)
- Per‑slot volume (saved), names, and loop toggle (default on)
- Output device selection (cpal/rodio)
- Crossfade between slots (linear, 20ms steps), old sink stops after fade
- Master volume (bottom panel)
- Settings persisted via confy (paths, volumes, device name, crossfade seconds, master volume, names, looping)
- macOS: .app bundle + ZIP + DMG (unsigned by default)
- Windows: ZIP containing the exe

## Downloads
- macOS:
  - `BGM Deck.dmg` (recommended) — unsigned by default
  - `BGM Deck.zip` — unsigned by default
- Windows:
  - `BGM Deck Windows.zip` — contains `BGM Deck.exe`

## macOS Notes
- Unsigned builds will trigger Gatekeeper:
  - Right‑click the app → Open (first run) or allow under System Settings → Privacy & Security
- If/when signing & notarization secrets are added to the repo, future releases will be notarized automatically.

## Windows Notes
- Extract the ZIP and run `BGM Deck.exe`.
- If SmartScreen appears, choose “More info” → “Run anyway” (unsigned builds).

## Known
- Some older GPUs may have issues with eframe/egui — try `RUST_BACKTRACE=1 cargo run` for logs.
- MP3 loading relies on rodio/symphonia; corrupted files may fail.

## Credits
- Created with Codex (Codex CLI).
