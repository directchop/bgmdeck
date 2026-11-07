# Changelog

## 0.9.0 — 2026-11-08

Complete rewrite on Tauri 2 + React (previously egui / rodio).

### New
- Banks of ten pads, with colours, names, per-pad volume and loop.
- Streaming playback engine: any file length, constant memory, sample-rate
  conversion, mono / multichannel downmix.
- Sample-accurate crossfade, fade in from silence, Stop (fade) / Stop now,
  equal-power / linear / S-curve envelopes.
- Duck button (`D`) with preset level and fade.
- Output device / sample rate / buffer selection, left-right output channel
  routing, output meter, automatic reopen after a device error.
- `.bgmdeck` files: save / open / Save As, session restore, unsaved-changes
  prompt, missing-file warnings, undo / redo.
- OSC receive (`/bgmdeck/…`), OSC state feedback, `/bgmdeck/ping` → `/pong`.
- MIDI note input with per-function Learn.
- Native menu bar (macOS / Windows / Linux), keyboard shortcuts and a
  shortcut sheet (`?`).
- In-app updates (manual install, blocked while playing), always-on log file.
- Signed / notarized release pipeline shared with playque.

### Removed
- The egui app under `bgm_deck/` and its confy settings. Pad assignments
  from 0.2 are not carried over.
