// MIDI note → command mapping, plus "learn" (next note pressed becomes the
// binding). Raw bytes arrive from Rust as `midi-message`.
import { midiConnect, onMidiMessage } from "./bridge";
import type { MidiMap } from "./prefs";
import { usePrefsStore } from "./prefsStore";
import { executeRemote, type RemoteCommand } from "./remoteCommands";

export type MidiTarget =
  | { kind: "pad"; index: number }
  | { kind: "stop" }
  | { kind: "stopNow" }
  | { kind: "duck" }
  | { kind: "bankPrev" }
  | { kind: "bankNext" };

export interface NoteOn {
  channel: number; // 1..16
  note: number;
  velocity: number;
}

/** Parse a Note On with velocity > 0 (Note On vel 0 is a Note Off). */
export function parseNoteOn(data: number[]): NoteOn | null {
  if (data.length < 3) return null;
  const status = data[0] & 0xf0;
  if (status !== 0x90) return null;
  const velocity = data[2] & 0x7f;
  if (velocity === 0) return null;
  return { channel: (data[0] & 0x0f) + 1, note: data[1] & 0x7f, velocity };
}

export function midiToCommand(data: number[], map: MidiMap): RemoteCommand | null {
  const on = parseNoteOn(data);
  if (!on) return null;
  if (map.channel !== 0 && map.channel !== on.channel) return null;
  const padIndex = map.padNotes.indexOf(on.note);
  if (padIndex >= 0) return { type: "play", pad: padIndex };
  if (on.note === map.stopNote) return { type: "stop" };
  if (on.note === map.stopNowNote) return { type: "stopNow" };
  if (on.note === map.duckNote) return { type: "duck", on: "toggle" };
  if (on.note === map.bankPrevNote) return { type: "bankPrev" };
  if (on.note === map.bankNextNote) return { type: "bankNext" };
  return null;
}

/** New map with `note` bound to `target` and removed from wherever it was. */
export function assignNote(map: MidiMap, target: MidiTarget, note: number): MidiMap {
  const next: MidiMap = { ...map, padNotes: map.padNotes.map((n) => (n === note ? -1 : n)) };
  for (const k of ["stopNote", "stopNowNote", "duckNote", "bankPrevNote", "bankNextNote"] as const) {
    if (next[k] === note) next[k] = -1;
  }
  switch (target.kind) {
    case "pad":
      next.padNotes = next.padNotes.map((n, i) => (i === target.index ? note : n));
      break;
    case "stop":
      next.stopNote = note;
      break;
    case "stopNow":
      next.stopNowNote = note;
      break;
    case "duck":
      next.duckNote = note;
      break;
    case "bankPrev":
      next.bankPrevNote = note;
      break;
    case "bankNext":
      next.bankNextNote = note;
      break;
  }
  return next;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(note: number): string {
  if (note < 0 || note > 127) return "—";
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

// ---- learn state (tiny external store so Settings can show it) ----

let learning: MidiTarget | null = null;
let lastNote: NoteOn | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const midiLearn = {
  target: () => learning,
  lastNote: () => lastNote,
  start(target: MidiTarget) {
    learning = target;
    notify();
  },
  cancel() {
    learning = null;
    notify();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function handleMidi(data: number[]): void {
  const on = parseNoteOn(data);
  if (on) {
    lastNote = on;
    notify();
  }
  if (learning) {
    if (!on) return;
    const prefs = usePrefsStore.getState();
    prefs.setMidiMap(assignNote(prefs.remote.midi, learning, on.note));
    learning = null;
    notify();
    return;
  }
  const cmd = midiToCommand(data, usePrefsStore.getState().remote.midi);
  if (cmd) executeRemote(cmd);
}

export function installMidi(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  onMidiMessage((m) => handleMidi(m.data)).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  const apply = async () => {
    const { remote, setMidiError } = usePrefsStore.getState();
    try {
      await midiConnect(remote.midiInput);
      setMidiError(null);
    } catch (e) {
      setMidiError(e instanceof Error ? e.message : String(e));
    }
  };
  void apply();
  const retry = setInterval(() => {
    const { remote, midiError } = usePrefsStore.getState();
    if (remote.midiInput && midiError) void apply();
  }, 5000);
  const off = usePrefsStore.subscribe((s, p) => {
    if (s.remote.midiInput !== p.remote.midiInput) void apply();
  });
  return () => {
    disposed = true;
    unlisten?.();
    clearInterval(retry);
    off();
  };
}
