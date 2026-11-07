// Deck data model. Everything here is what a .bgmdeck file stores, plus the
// transient playback state the engine reports back.

export type FadeCurve = "equal-power" | "linear" | "s-curve";

export const PAD_COLORS = ["amber", "red", "pink", "purple", "blue", "teal", "green", "lime", "slate"] as const;
export type PadColor = (typeof PAD_COLORS)[number];

export interface Slot {
  id: string;
  /** Display name; empty = file name. */
  name: string;
  path: string | null;
  /** Seconds; null until the file has been measured. */
  duration: number | null;
  /** Waveform thumbnail 0..1 (from the engine), null until measured. */
  peaks: number[] | null;
  /** 0..1 linear gain. */
  volume: number;
  loop: boolean;
  color: PadColor | null;
  /** True when the file was not found at load time. */
  missing?: boolean;
  /** Decode / open error reported by the engine. */
  error?: string | null;
}

export const SLOTS_PER_BANK = 10;

export interface Bank {
  id: string;
  name: string;
  slots: Slot[];
}

export interface DeckSettings {
  /** Fade time when one pad replaces another. */
  crossfadeSec: number;
  /** Fade-in from silence (nothing was playing). */
  startFadeSec: number;
  /** Stop (Fade) time. */
  stopFadeSec: number;
  fadeCurve: FadeCurve;
  /** Gain while ducked, 0..1. */
  duckLevel: number;
  duckFadeSec: number;
  /** Master gain 0..1. */
  master: number;
  /** Tapping the pad that is already playing fades it out. */
  tapToStop: boolean;
}

export interface DeckData {
  name: string;
  banks: Bank[];
  settings: DeckSettings;
}

export type Stage = "fadeIn" | "steady" | "fadeOut";

export interface PlayingVoice {
  gen: number;
  slotId: string;
  position: number;
  duration: number | null;
  stage: Stage;
  env: number;
}

export interface DeckStatus {
  voices: PlayingVoice[];
  peak: [number, number];
  master: number;
  duck: number;
  underruns: number;
}

export const DEFAULT_SETTINGS: DeckSettings = {
  crossfadeSec: 3,
  startFadeSec: 0.05,
  stopFadeSec: 3,
  fadeCurve: "equal-power",
  duckLevel: 0.25,
  duckFadeSec: 0.6,
  master: 1,
  tapToStop: true,
};
