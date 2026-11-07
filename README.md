# BGM Deck

Pad-style background music player for live events — the walk-in music, the
dinner set, the interval, the bows. Ten pads per bank, as many banks as the
show needs, sample-accurate crossfades, a Duck button for announcements, and
OSC / MIDI control so the show PC (for example [playque](https://github.com/directchop/playque))
can fade the music at the right moment.

Free and open source. macOS (Apple Silicon / Intel), Windows, Linux.

## What it does

- **Pads**: drop audio files on pads (WAV, AIFF, MP3, FLAC, AAC / M4A, OGG).
  Name, colour, per-pad volume, loop on/off. Keys `1`–`9`, `0` play pads 1–10.
- **Banks**: group pads by part of the show; `[` / `]` or OSC to switch.
- **Streaming playback**: files of any length are decoded on the fly (a deck
  with 80 one-hour tracks uses a few megabytes of RAM). Mono, stereo and
  multichannel files all play; sample rates are converted to the device rate.
- **Fades you can rely on**: crossfade between pads, fade in from silence,
  Stop (fade) / Stop now, equal-power / linear / S-curve. All computed per
  sample in the audio callback — no stepping, no zipper noise.
- **Duck**: one key (`D`) lowers the music to a preset level for an MC and
  brings it back.
- **Output**: choose the audio device, sample rate, buffer size and which two
  physical outputs carry the deck. Output meter in the header.
- **Decks**: save / open `.bgmdeck` files; the working deck is restored on
  relaunch; unsaved changes are guarded; missing files are flagged.
- **Remote control**: OSC in (with state feedback out) and MIDI note input
  with Learn. See *Remote control* below.
- **Native menus**, keyboard shortcuts (`?` shows them all), in-app updates,
  always-on log file (Help → Open Log Folder).

## Remote control

### OSC

Enable *Settings → Remote → OSC receive* and pick a UDP port (default 9100).
Pads and banks are numbered from 1 on the wire.

| Address | Effect |
| --- | --- |
| `/bgmdeck/play <pad> [fade]` | Play pad 1–10 of the current bank |
| `/bgmdeck/play/<pad> [fade]` | Same, pad in the address |
| `/bgmdeck/bank/<bank>/play/<pad>` | Play a pad in another bank (switches to it) |
| `/bgmdeck/stop [fade]` | Fade out (deck's Stop fade unless given) |
| `/bgmdeck/stop/now` | Stop immediately |
| `/bgmdeck/bank <bank>`, `/bgmdeck/bank/<bank>` | Switch bank |
| `/bgmdeck/bank/next`, `/bgmdeck/bank/prev` | Step through banks |
| `/bgmdeck/master <0..1>` | Master volume |
| `/bgmdeck/pad/<pad>/volume <0..1>` | Pad volume (current bank) |
| `/bgmdeck/duck <0\|1>`, `/bgmdeck/duck/on`, `/off`, `/toggle` | Duck |
| `/bgmdeck/ping` | Replies `/bgmdeck/pong` to the sender |

Feedback (to the *State feedback* targets, on every change and once a second
while playing):

```
/bgmdeck/state  s state("stopped"|"playing"|"fading")  i bank  i pad  s name  f position  f duration
```

**With playque**: add an OSC track whose target is the BGM Deck machine and
port, then put `/bgmdeck/stop` on the cue where the show starts (or
`/bgmdeck/play/3` to start the interval music from the timeline).

### MIDI

Pick an input under *Settings → Remote → MIDI*. Note On messages trigger pads,
Stop, Stop now, Duck and bank changes; click *Learn* next to any row and press
a key to bind it. Defaults follow a typical pad controller (note 36 = pad 1).

## Keyboard

| Key | Action |
| --- | --- |
| `1`–`9`, `0` | Play pad (tap the playing pad again to fade it out; Shift restarts) |
| `Space` / `Shift+Space` | Stop (fade) / Stop now |
| `D` | Duck on / off |
| `[` / `]` | Previous / next bank |
| `Tab` | Pads ⇄ Settings |
| `Enter`, `Delete` | Rename / clear the selected pad |
| `⌘/Ctrl + S`, `O`, `N` | Save, Open, New deck |
| `⌘/Ctrl + Z` | Undo (pads and settings) |
| `?` | All shortcuts |

## Development

```bash
npm install
npm run tauri dev        # app with hot reload
npm test                 # frontend unit tests (node --test)
cd src-tauri && cargo test
```

Stack: Tauri 2 (Rust) + React / TypeScript / Tailwind. Audio: cpal output,
symphonia decoding on a thread per pad into a lock-free ring buffer, mixing
and envelopes in `src-tauri/src/audio.rs`. OSC via rosc, MIDI via midir.

Releases are built by `.github/workflows/release.yml` on a `v*` tag (signed /
notarized when the secrets are set) and served to the in-app updater by the
Cloudflare Worker in `updates-worker/`. See `docs/DISTRIBUTION.md`.

## History

BGM Deck 0.1–0.2 (2025) was a small egui / rodio app with the same 10-slot
idea. 0.9 is a rewrite on the playque stack: streaming engine, banks, OSC,
native menus, updater, signed builds. Decks from the old version are not
imported (it kept no deck files, only app settings).

## License

TBD — the app is free to use. Code license to be chosen before 1.0.
