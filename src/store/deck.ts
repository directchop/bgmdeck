// Deck state: banks of pads, deck-wide settings, undo history and the live
// playback status reported by the engine. Playback actions talk to the
// engine directly; file/loop/volume/settings changes are mirrored to it by
// `engineSync.ts`.
import { create } from "zustand";
import { deckPlay, deckStop, deckStopSlot, logFrontend } from "../bridge";
import { emptyBank, emptySlot, newDeckData } from "../deckFile";
import {
  SLOTS_PER_BANK,
  type Bank,
  type DeckData,
  type DeckSettings,
  type DeckStatus,
  type PadColor,
  type PlayingVoice,
  type Slot,
} from "./types";

const MAX_UNDO = 100;

interface Snapshot {
  name: string;
  banks: Bank[];
  settings: DeckSettings;
}

export interface DeckState extends DeckData {
  deckPath: string | null;
  dirty: boolean;
  currentBankId: string;
  selectedSlotId: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];

  // Live engine status
  voices: PlayingVoice[];
  peak: [number, number];
  duckOn: boolean;
  engineStarted: boolean;
  engineError: string | null;
  underruns: number;

  // Deck lifecycle
  getDeckData: () => DeckData;
  loadDeckData: (data: DeckData, path: string | null) => void;
  resetDeck: () => void;
  markSaved: (path: string) => void;
  setDeckName: (name: string) => void;

  // Banks
  addBank: () => void;
  renameBank: (bankId: string, name: string) => void;
  deleteBank: (bankId: string) => void;
  selectBank: (bankId: string) => void;
  selectBankIndex: (index: number) => void;
  nextBank: () => void;
  prevBank: () => void;

  // Pads
  selectSlot: (slotId: string | null) => void;
  assignFile: (slotId: string, path: string) => void;
  setSlotInfo: (slotId: string, info: { duration: number; peaks: number[] } | null, error?: string | null) => void;
  setSlotMissing: (slotId: string, missing: boolean) => void;
  setSlotName: (slotId: string, name: string) => void;
  setSlotVolume: (slotId: string, volume: number, commit?: boolean) => void;
  setSlotLoop: (slotId: string, loop: boolean) => void;
  setSlotColor: (slotId: string, color: PadColor | null) => void;
  clearSlot: (slotId: string) => void;
  swapSlots: (aId: string, bId: string) => void;

  // Settings
  updateSettings: (patch: Partial<DeckSettings>) => void;
  setMaster: (master: number) => void;

  // Transport
  play: (slotId: string, opts?: { restart?: boolean }) => Promise<void>;
  playPad: (index: number, bankIndex?: number) => Promise<void>;
  stop: (fade?: number) => Promise<void>;
  stopNow: () => Promise<void>;
  stopSlot: (slotId: string, fade?: number) => Promise<void>;
  setDuck: (on: boolean) => void;
  toggleDuck: () => void;
  applyStatus: (status: DeckStatus) => void;
  setEngineStarted: (started: boolean, error?: string | null) => void;

  // History
  pushUndo: () => void;
  undo: () => void;
  redo: () => void;
}

const snapshotOf = (s: Pick<DeckState, "name" | "banks" | "settings">): Snapshot => ({
  name: s.name,
  banks: s.banks,
  settings: s.settings,
});

export function findSlot(banks: Bank[], slotId: string): { bank: Bank; slot: Slot; bankIndex: number; slotIndex: number } | null {
  for (let b = 0; b < banks.length; b++) {
    const i = banks[b].slots.findIndex((s) => s.id === slotId);
    if (i >= 0) return { bank: banks[b], slot: banks[b].slots[i], bankIndex: b, slotIndex: i };
  }
  return null;
}

function mapSlot(banks: Bank[], slotId: string, fn: (s: Slot) => Slot): Bank[] {
  return banks.map((b) =>
    b.slots.some((s) => s.id === slotId) ? { ...b, slots: b.slots.map((s) => (s.id === slotId ? fn(s) : s)) } : b,
  );
}

/** Voices that are audible and not on their way out, newest first. */
export function activeVoices(voices: PlayingVoice[]): PlayingVoice[] {
  return voices.filter((v) => v.stage !== "fadeOut").sort((a, b) => b.gen - a.gen);
}

export function isSlotPlaying(voices: PlayingVoice[], slotId: string): boolean {
  return voices.some((v) => v.slotId === slotId && v.stage !== "fadeOut");
}

const initial = newDeckData();

export const useDeckStore = create<DeckState>((set, get) => ({
  ...initial,
  deckPath: null,
  dirty: false,
  currentBankId: initial.banks[0].id,
  selectedSlotId: null,
  undoStack: [],
  redoStack: [],
  voices: [],
  peak: [0, 0],
  duckOn: false,
  engineStarted: false,
  engineError: null,
  underruns: 0,

  getDeckData: () => {
    const s = get();
    return { name: s.name, banks: s.banks, settings: s.settings };
  },

  loadDeckData: (data, path) => {
    set({
      name: data.name,
      banks: data.banks,
      settings: data.settings,
      deckPath: path,
      dirty: false,
      currentBankId: data.banks[0].id,
      selectedSlotId: null,
      undoStack: [],
      redoStack: [],
      duckOn: false,
    });
  },

  resetDeck: () => get().loadDeckData(newDeckData(), null),

  markSaved: (path) => set({ deckPath: path, dirty: false }),

  setDeckName: (name) => {
    get().pushUndo();
    set({ name, dirty: true });
  },

  // ---- banks ----
  addBank: () => {
    get().pushUndo();
    const bank = emptyBank(`Bank ${get().banks.length + 1}`);
    set((s) => ({ banks: [...s.banks, bank], currentBankId: bank.id, dirty: true }));
  },
  renameBank: (bankId, name) => {
    get().pushUndo();
    set((s) => ({ banks: s.banks.map((b) => (b.id === bankId ? { ...b, name } : b)), dirty: true }));
  },
  deleteBank: (bankId) => {
    const s = get();
    if (s.banks.length <= 1) return;
    s.pushUndo();
    const idx = s.banks.findIndex((b) => b.id === bankId);
    const banks = s.banks.filter((b) => b.id !== bankId);
    const current = s.currentBankId === bankId ? banks[Math.max(0, Math.min(idx, banks.length - 1))].id : s.currentBankId;
    set({ banks, currentBankId: current, dirty: true, selectedSlotId: null });
  },
  selectBank: (bankId) => {
    if (get().banks.some((b) => b.id === bankId)) set({ currentBankId: bankId, selectedSlotId: null });
  },
  selectBankIndex: (index) => {
    const b = get().banks[index];
    if (b) set({ currentBankId: b.id, selectedSlotId: null });
  },
  nextBank: () => {
    const s = get();
    const i = s.banks.findIndex((b) => b.id === s.currentBankId);
    s.selectBankIndex((i + 1) % s.banks.length);
  },
  prevBank: () => {
    const s = get();
    const i = s.banks.findIndex((b) => b.id === s.currentBankId);
    s.selectBankIndex((i - 1 + s.banks.length) % s.banks.length);
  },

  // ---- pads ----
  selectSlot: (slotId) => set({ selectedSlotId: slotId }),

  assignFile: (slotId, path) => {
    get().pushUndo();
    set((s) => ({
      banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, path, duration: null, peaks: null, missing: false, error: null })),
      dirty: true,
    }));
  },

  setSlotInfo: (slotId, info, error = null) => {
    set((s) => ({
      banks: mapSlot(s.banks, slotId, (sl) =>
        info ? { ...sl, duration: info.duration, peaks: info.peaks, error: null, missing: false } : { ...sl, error },
      ),
    }));
  },

  setSlotMissing: (slotId, missing) => {
    set((s) => ({ banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, missing })) }));
  },

  setSlotName: (slotId, name) => {
    get().pushUndo();
    set((s) => ({ banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, name })), dirty: true }));
  },

  setSlotVolume: (slotId, volume, commit = true) => {
    const v = Math.min(1, Math.max(0, volume));
    if (commit) get().pushUndo();
    set((s) => ({ banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, volume: v })), dirty: true }));
  },

  setSlotLoop: (slotId, loop) => {
    get().pushUndo();
    set((s) => ({ banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, loop })), dirty: true }));
  },

  setSlotColor: (slotId, color) => {
    get().pushUndo();
    set((s) => ({ banks: mapSlot(s.banks, slotId, (sl) => ({ ...sl, color })), dirty: true }));
  },

  clearSlot: (slotId) => {
    get().pushUndo();
    void get().stopSlot(slotId, 0.1);
    set((s) => ({
      banks: mapSlot(s.banks, slotId, () => ({ ...emptySlot(), id: slotId })),
      dirty: true,
    }));
  },

  swapSlots: (aId, bId) => {
    if (aId === bId) return;
    const s = get();
    const a = findSlot(s.banks, aId);
    const b = findSlot(s.banks, bId);
    if (!a || !b) return;
    s.pushUndo();
    // Positions swap, ids travel with their content so engine bindings stay valid.
    const banks = s.banks.map((bank) => {
      if (bank.id !== a.bank.id && bank.id !== b.bank.id) return bank;
      const slots = bank.slots.slice();
      if (bank.id === a.bank.id) slots[a.slotIndex] = b.slot;
      if (bank.id === b.bank.id) slots[b.slotIndex] = a.slot;
      return { ...bank, slots };
    });
    set({ banks, dirty: true });
  },

  // ---- settings ----
  updateSettings: (patch) => {
    get().pushUndo();
    set((s) => ({ settings: { ...s.settings, ...patch }, dirty: true }));
  },
  setMaster: (master) => {
    set((s) => ({ settings: { ...s.settings, master: Math.min(1, Math.max(0, master)) }, dirty: true }));
  },

  // ---- transport ----
  play: async (slotId, opts) => {
    const s = get();
    const found = findSlot(s.banks, slotId);
    if (!found || !found.slot.path) return;
    const playing = isSlotPlaying(s.voices, slotId);
    if (playing && s.settings.tapToStop && !opts?.restart) {
      await s.stopSlot(slotId);
      return;
    }
    const anythingPlaying = activeVoices(s.voices).length > 0;
    const fadeIn = anythingPlaying ? s.settings.crossfadeSec : s.settings.startFadeSec;
    try {
      await deckPlay(slotId, found.slot.volume, Math.max(0.005, fadeIn), s.settings.crossfadeSec);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((st) => ({ banks: mapSlot(st.banks, slotId, (sl) => ({ ...sl, error: message })) }));
      void logFrontend("error", `Play failed for pad: ${message}`).catch(() => {});
    }
  },

  playPad: async (index, bankIndex) => {
    const s = get();
    const bank = bankIndex === undefined ? s.banks.find((b) => b.id === s.currentBankId) : s.banks[bankIndex];
    const slot = bank?.slots[index];
    if (!slot) return;
    if (bankIndex !== undefined && bank && bank.id !== s.currentBankId) set({ currentBankId: bank.id });
    await s.play(slot.id);
  },

  stop: async (fade) => {
    await deckStop(fade ?? get().settings.stopFadeSec);
  },
  stopNow: async () => {
    await deckStop(0);
  },
  stopSlot: async (slotId, fade) => {
    await deckStopSlot(slotId, fade ?? get().settings.stopFadeSec);
  },

  setDuck: (on) => set({ duckOn: on }),
  toggleDuck: () => set((s) => ({ duckOn: !s.duckOn })),

  applyStatus: (status) => {
    set({ voices: status.voices, peak: status.peak, underruns: status.underruns });
  },

  setEngineStarted: (started, error = null) => set({ engineStarted: started, engineError: error }),

  // ---- history ----
  pushUndo: () => {
    set((s) => ({ undoStack: [...s.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(s)], redoStack: [] }));
  },
  undo: () => {
    const s = get();
    const prev = s.undoStack[s.undoStack.length - 1];
    if (!prev) return;
    set({
      ...prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, snapshotOf(s)],
      dirty: true,
      currentBankId: prev.banks.some((b) => b.id === s.currentBankId) ? s.currentBankId : prev.banks[0].id,
    });
  },
  redo: () => {
    const s = get();
    const next = s.redoStack[s.redoStack.length - 1];
    if (!next) return;
    set({
      ...next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, snapshotOf(s)],
      dirty: true,
      currentBankId: next.banks.some((b) => b.id === s.currentBankId) ? s.currentBankId : next.banks[0].id,
    });
  },
}));

export { SLOTS_PER_BANK };
