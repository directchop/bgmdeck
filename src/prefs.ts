// Machine-local preferences (localStorage): audio device, remote control,
// updates. These are deliberately not part of the .bgmdeck file, which
// travels between computers with different interfaces and networks.

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return fallback;
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota
  }
}

// ---- audio ----

export const AUDIO_PREFS_KEY = "bgmdeck.audio.v1";

export interface AudioPrefs {
  deviceId: string | null;
  /** 0 = device default. */
  sampleRate: number;
  /** 0 = device default. */
  bufferSize: number;
  /** Output channel indices (0-based) for left / right. */
  left: number;
  right: number;
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = { deviceId: null, sampleRate: 0, bufferSize: 0, left: 0, right: 1 };

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

export function parseAudioPrefs(raw: unknown): AudioPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    deviceId: typeof p.deviceId === "string" && p.deviceId ? p.deviceId : null,
    sampleRate: num(p.sampleRate, 0),
    bufferSize: num(p.bufferSize, 0),
    left: Math.floor(num(p.left, 0)),
    right: Math.floor(num(p.right, 1)),
  };
}

export const loadAudioPrefs = () => load(AUDIO_PREFS_KEY, parseAudioPrefs, DEFAULT_AUDIO_PREFS);
export const saveAudioPrefs = (p: AudioPrefs) => save(AUDIO_PREFS_KEY, p);

// ---- remote (OSC / MIDI) ----

export const REMOTE_PREFS_KEY = "bgmdeck.remote.v1";

export interface MidiMap {
  /** Note numbers for pads 1..10 (-1 = unassigned). */
  padNotes: number[];
  stopNote: number;
  stopNowNote: number;
  duckNote: number;
  bankPrevNote: number;
  bankNextNote: number;
  /** 0 = any channel, 1..16. */
  channel: number;
}

export interface RemotePrefs {
  oscEnabled: boolean;
  oscPort: number;
  oscInterface: string;
  /** "ip:port" feedback targets. */
  oscFeedbackTargets: string[];
  midiInput: string | null;
  midi: MidiMap;
}

export const DEFAULT_MIDI_MAP: MidiMap = {
  padNotes: [36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
  stopNote: 46,
  stopNowNote: 47,
  duckNote: 48,
  bankPrevNote: 49,
  bankNextNote: 50,
  channel: 0,
};

export const DEFAULT_REMOTE_PREFS: RemotePrefs = {
  oscEnabled: false,
  oscPort: 9100,
  oscInterface: "",
  oscFeedbackTargets: [],
  midiInput: null,
  midi: DEFAULT_MIDI_MAP,
};

const note = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= -1 && v <= 127 ? v : fallback;

export function parseRemotePrefs(raw: unknown): RemotePrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const m = (p.midi && typeof p.midi === "object" ? p.midi : {}) as Record<string, unknown>;
  const padNotes = Array.isArray(m.padNotes) ? m.padNotes : [];
  return {
    oscEnabled: p.oscEnabled === true,
    oscPort: typeof p.oscPort === "number" && p.oscPort >= 1 && p.oscPort <= 65535 ? Math.floor(p.oscPort) : DEFAULT_REMOTE_PREFS.oscPort,
    oscInterface: typeof p.oscInterface === "string" ? p.oscInterface : "",
    oscFeedbackTargets: Array.isArray(p.oscFeedbackTargets) ? p.oscFeedbackTargets.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [],
    midiInput: typeof p.midiInput === "string" && p.midiInput ? p.midiInput : null,
    midi: {
      padNotes: DEFAULT_MIDI_MAP.padNotes.map((d, i) => note(padNotes[i], d)),
      stopNote: note(m.stopNote, DEFAULT_MIDI_MAP.stopNote),
      stopNowNote: note(m.stopNowNote, DEFAULT_MIDI_MAP.stopNowNote),
      duckNote: note(m.duckNote, DEFAULT_MIDI_MAP.duckNote),
      bankPrevNote: note(m.bankPrevNote, DEFAULT_MIDI_MAP.bankPrevNote),
      bankNextNote: note(m.bankNextNote, DEFAULT_MIDI_MAP.bankNextNote),
      channel: typeof m.channel === "number" && m.channel >= 0 && m.channel <= 16 ? Math.floor(m.channel) : 0,
    },
  };
}

export const loadRemotePrefs = () => load(REMOTE_PREFS_KEY, parseRemotePrefs, DEFAULT_REMOTE_PREFS);
export const saveRemotePrefs = (p: RemotePrefs) => save(REMOTE_PREFS_KEY, p);

// ---- UI ----

export const UI_PREFS_KEY = "bgmdeck.ui.v1";

export interface UiPrefs {
  showWaveforms: boolean;
}

export const loadUiPrefs = (): UiPrefs =>
  load(UI_PREFS_KEY, (raw) => ({ showWaveforms: (raw as any)?.showWaveforms !== false }), { showWaveforms: true });
export const saveUiPrefs = (p: UiPrefs) => save(UI_PREFS_KEY, p);
