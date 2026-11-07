// Reactive wrapper around the machine-local prefs so Settings and the
// remote-control glue see the same values. Persists on every change.
import { create } from "zustand";
import {
  loadAudioPrefs,
  loadRemotePrefs,
  saveAudioPrefs,
  saveRemotePrefs,
  type AudioPrefs,
  type RemotePrefs,
} from "./prefs";

interface PrefsState {
  audio: AudioPrefs;
  /** What the engine actually opened (null until started). */
  applied: { deviceId: string; sampleRate: number; channels: number } | null;
  remote: RemotePrefs;
  oscError: string | null;
  midiError: string | null;
  setAudio: (patch: Partial<AudioPrefs>) => void;
  setApplied: (a: PrefsState["applied"]) => void;
  setRemote: (patch: Partial<RemotePrefs>) => void;
  setMidiMap: (patch: Partial<RemotePrefs["midi"]>) => void;
  setOscError: (e: string | null) => void;
  setMidiError: (e: string | null) => void;
}

export const usePrefsStore = create<PrefsState>((set) => ({
  audio: loadAudioPrefs(),
  applied: null,
  remote: loadRemotePrefs(),
  oscError: null,
  midiError: null,
  setAudio: (patch) =>
    set((s) => {
      const audio = { ...s.audio, ...patch };
      saveAudioPrefs(audio);
      return { audio };
    }),
  setApplied: (applied) => set({ applied }),
  setRemote: (patch) =>
    set((s) => {
      const remote = { ...s.remote, ...patch };
      saveRemotePrefs(remote);
      return { remote };
    }),
  setMidiMap: (patch) =>
    set((s) => {
      const remote = { ...s.remote, midi: { ...s.remote.midi, ...patch } };
      saveRemotePrefs(remote);
      return { remote };
    }),
  setOscError: (oscError) => set({ oscError }),
  setMidiError: (midiError) => set({ midiError }),
}));
