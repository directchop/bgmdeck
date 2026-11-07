// .bgmdeck file format: JSON, forward-compatible (unknown keys ignored,
// missing keys defaulted). `format`/`version` let a future version migrate.
import {
  DEFAULT_SETTINGS,
  PAD_COLORS,
  SLOTS_PER_BANK,
  type Bank,
  type DeckData,
  type DeckSettings,
  type FadeCurve,
  type PadColor,
  type Slot,
} from "./store/types";

export const DECK_FORMAT = "bgmdeck";
export const DECK_VERSION = 1;

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function emptySlot(): Slot {
  return { id: newId("slot"), name: "", path: null, duration: null, peaks: null, volume: 1, loop: true, color: null };
}

export function emptyBank(name: string): Bank {
  return { id: newId("bank"), name, slots: Array.from({ length: SLOTS_PER_BANK }, emptySlot) };
}

export function newDeckData(): DeckData {
  return { name: "Untitled", banks: [emptyBank("Bank 1")], settings: { ...DEFAULT_SETTINGS } };
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Name shown on a pad: explicit name, else file name without extension. */
export function slotLabel(slot: Pick<Slot, "name" | "path">): string {
  if (slot.name.trim()) return slot.name;
  if (slot.path) return fileNameOf(slot.path).replace(/\.[^.]+$/, "");
  return "";
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const nonNeg = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

function parseCurve(v: unknown): FadeCurve {
  return v === "linear" || v === "s-curve" || v === "equal-power" ? v : DEFAULT_SETTINGS.fadeCurve;
}

function parseColor(v: unknown): PadColor | null {
  return typeof v === "string" && (PAD_COLORS as readonly string[]).includes(v) ? (v as PadColor) : null;
}

function parseSettings(raw: unknown): DeckSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    crossfadeSec: nonNeg(s.crossfadeSec, DEFAULT_SETTINGS.crossfadeSec),
    startFadeSec: nonNeg(s.startFadeSec, DEFAULT_SETTINGS.startFadeSec),
    stopFadeSec: nonNeg(s.stopFadeSec, DEFAULT_SETTINGS.stopFadeSec),
    fadeCurve: parseCurve(s.fadeCurve),
    duckLevel: clamp01(s.duckLevel, DEFAULT_SETTINGS.duckLevel),
    duckFadeSec: nonNeg(s.duckFadeSec, DEFAULT_SETTINGS.duckFadeSec),
    master: clamp01(s.master, DEFAULT_SETTINGS.master),
    tapToStop: typeof s.tapToStop === "boolean" ? s.tapToStop : DEFAULT_SETTINGS.tapToStop,
  };
}

function parseSlot(raw: unknown, seen: Set<string>): Slot {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let id = typeof s.id === "string" && s.id ? s.id : newId("slot");
  while (seen.has(id)) id = newId("slot");
  seen.add(id);
  const path = typeof s.path === "string" && s.path ? s.path : null;
  return {
    id,
    name: typeof s.name === "string" ? s.name : "",
    path,
    duration: path && typeof s.duration === "number" && s.duration > 0 ? s.duration : null,
    peaks: path && Array.isArray(s.peaks) ? (s.peaks as unknown[]).map((p) => clamp01(p, 0)) : null,
    volume: clamp01(s.volume, 1),
    loop: typeof s.loop === "boolean" ? s.loop : true,
    color: parseColor(s.color),
  };
}

function parseBank(raw: unknown, index: number, seen: Set<string>): Bank {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawSlots = Array.isArray(b.slots) ? b.slots : [];
  const slots: Slot[] = [];
  for (let i = 0; i < SLOTS_PER_BANK; i++) {
    slots.push(i < rawSlots.length ? parseSlot(rawSlots[i], seen) : emptySlot());
  }
  return {
    id: typeof b.id === "string" && b.id ? b.id : newId("bank"),
    name: typeof b.name === "string" && b.name.trim() ? b.name : `Bank ${index + 1}`,
    slots,
  };
}

/** Parse a .bgmdeck document. Throws on non-JSON / wrong format. */
export function parseDeck(text: string): DeckData {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Not a BGM Deck file (invalid JSON)");
  }
  if (!doc || typeof doc !== "object") throw new Error("Not a BGM Deck file");
  const d = doc as Record<string, unknown>;
  if (d.format !== undefined && d.format !== DECK_FORMAT) throw new Error(`Not a BGM Deck file (format "${String(d.format)}")`);
  if (typeof d.version === "number" && d.version > DECK_VERSION) {
    throw new Error(`This deck was saved by a newer BGM Deck (format v${d.version}). Please update.`);
  }
  const seen = new Set<string>();
  const rawBanks = Array.isArray(d.banks) && d.banks.length > 0 ? d.banks : [{}];
  const banks = rawBanks.map((b, i) => parseBank(b, i, seen));
  return {
    name: typeof d.name === "string" && d.name.trim() ? d.name : "Untitled",
    banks,
    settings: parseSettings(d.settings),
  };
}

export function serializeDeck(deck: DeckData): string {
  const doc = {
    format: DECK_FORMAT,
    version: DECK_VERSION,
    app: `bgmdeck ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"}`,
    name: deck.name,
    settings: deck.settings,
    banks: deck.banks.map((b) => ({
      id: b.id,
      name: b.name,
      slots: b.slots.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        duration: s.duration,
        peaks: s.peaks,
        volume: s.volume,
        loop: s.loop,
        color: s.color,
      })),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Deck name from a file path ("/shows/Gala.bgmdeck" → "Gala"). */
export function deckNameFromPath(path: string): string {
  return fileNameOf(path).replace(/\.bgmdeck$/i, "");
}
