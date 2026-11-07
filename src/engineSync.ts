// Keeps the engine in step with the deck store:
//   files        → slot_load / slot_unload (measured length & peaks come back)
//   loop/volume  → slot_set_looping / slot_set_volume (live)
//   settings     → master, curve, duck
//   prefs        → routing
// and feeds `deck-status` events back into the store.
import {
  audioRestart,
  deckSetCurve,
  deckSetDuck,
  deckSetMaster,
  deckSetRouting,
  logFrontend,
  onDeckStatus,
  slotLoad,
  slotSetLooping,
  slotSetVolume,
  slotUnload,
} from "./bridge";
import { usePrefsStore } from "./prefsStore";
import { useDeckStore } from "./store/deck";
import type { Bank, Slot } from "./store/types";

const MAX_CONCURRENT_LOADS = 3;

interface Bound {
  path: string;
  loop: boolean;
  volume: number;
}

/** Engine-side view of every pad, keyed by slot id. */
const bound = new Map<string, Bound>();
const queue: (() => Promise<void>)[] = [];
let running = 0;

function enqueue(job: () => Promise<void>) {
  queue.push(job);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT_LOADS && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

function loadSlot(slot: Slot) {
  const path = slot.path!;
  bound.set(slot.id, { path, loop: slot.loop, volume: slot.volume });
  enqueue(async () => {
    // Skip if the pad changed again while queued.
    const now = bound.get(slot.id);
    if (!now || now.path !== path) return;
    try {
      const info = await slotLoad(slot.id, path, slot.loop);
      const cur = bound.get(slot.id);
      if (cur && cur.path === path) useDeckStore.getState().setSlotInfo(slot.id, { duration: info.duration, peaks: info.peaks });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void logFrontend("warn", `Could not load ${path}: ${message}`).catch(() => {});
      const cur = bound.get(slot.id);
      if (cur && cur.path === path) useDeckStore.getState().setSlotInfo(slot.id, null, message);
    }
  });
}

/** Diff the store's pads against what the engine has. */
export function syncSlots(banks: Bank[]): void {
  const seen = new Set<string>();
  for (const bank of banks) {
    for (const slot of bank.slots) {
      seen.add(slot.id);
      const b = bound.get(slot.id);
      if (!slot.path) {
        if (b) {
          bound.delete(slot.id);
          void slotUnload(slot.id).catch(() => {});
        }
        continue;
      }
      if (!b || b.path !== slot.path) {
        loadSlot(slot);
        continue;
      }
      if (b.loop !== slot.loop) {
        b.loop = slot.loop;
        void slotSetLooping(slot.id, slot.loop).catch(() => {});
      }
      if (b.volume !== slot.volume) {
        b.volume = slot.volume;
        void slotSetVolume(slot.id, slot.volume).catch(() => {});
      }
    }
  }
  for (const id of [...bound.keys()]) {
    if (!seen.has(id)) {
      bound.delete(id);
      void slotUnload(id).catch(() => {});
    }
  }
}

/** Push everything (after an engine start or restart). */
export function seedEngine(): void {
  bound.clear();
  const s = useDeckStore.getState();
  const p = usePrefsStore.getState();
  syncSlots(s.banks);
  void deckSetMaster(s.settings.master).catch(() => {});
  void deckSetCurve(s.settings.fadeCurve).catch(() => {});
  void deckSetDuck(s.duckOn, s.settings.duckLevel, s.settings.duckFadeSec).catch(() => {});
  void deckSetRouting(p.audio.left, p.audio.right).catch(() => {});
}

/** Open the output with the stored prefs; fall back to the default device. */
export async function startEngine(): Promise<void> {
  const prefs = usePrefsStore.getState();
  const a = prefs.audio;
  const attempts: [string | null, string][] = a.deviceId ? [[a.deviceId, a.deviceId], [null, "default device"]] : [[null, "default device"]];
  for (const [deviceId, label] of attempts) {
    try {
      const applied = await audioRestart(deviceId, a.sampleRate || null, a.bufferSize || null);
      prefs.setApplied(applied);
      useDeckStore.getState().setEngineStarted(true, deviceId !== a.deviceId && a.deviceId ? `"${a.deviceId}" not found; using ${applied.deviceId}` : null);
      seedEngine();
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void logFrontend("warn", `Audio start on ${label} failed: ${message}`).catch(() => {});
      useDeckStore.getState().setEngineStarted(false, message);
    }
  }
  // No output, but pads can still be loaded and measured.
  seedEngine();
}

export function installEngineSync(): () => void {
  const offDeck = useDeckStore.subscribe((s, p) => {
    if (s.banks !== p.banks) syncSlots(s.banks);
    if (s.settings.master !== p.settings.master) void deckSetMaster(s.settings.master).catch(() => {});
    if (s.settings.fadeCurve !== p.settings.fadeCurve) void deckSetCurve(s.settings.fadeCurve).catch(() => {});
    if (
      s.duckOn !== p.duckOn ||
      s.settings.duckLevel !== p.settings.duckLevel ||
      s.settings.duckFadeSec !== p.settings.duckFadeSec
    ) {
      void deckSetDuck(s.duckOn, s.settings.duckLevel, s.settings.duckFadeSec).catch(() => {});
    }
  });
  const offPrefs = usePrefsStore.subscribe((s, p) => {
    if (s.audio.left !== p.audio.left || s.audio.right !== p.audio.right) {
      void deckSetRouting(s.audio.left, s.audio.right).catch(() => {});
    }
  });
  let unlisten: (() => void) | null = null;
  let disposed = false;
  onDeckStatus((status) => useDeckStore.getState().applyStatus(status)).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  return () => {
    disposed = true;
    offDeck();
    offPrefs();
    unlisten?.();
  };
}
