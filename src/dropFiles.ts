// OS file drops (Tauri drag-drop events). A drop on a pad assigns it; extra
// files fill the pads that follow. A drop anywhere else fills empty pads of
// the current bank in order.
import { useDeckStore } from "./store/deck";

export const AUDIO_FILE_RE = /\.(wav|aiff?|mp3|flac|ogg|oga|aac|m4a|mp4)$/i;

let dragOverSlot: string | null = null;
const listeners = new Set<(id: string | null) => void>();

export function subscribeDragOver(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setDragOver(id: string | null) {
  if (id === dragOverSlot) return;
  dragOverSlot = id;
  listeners.forEach((fn) => fn(id));
}

export function slotAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pad = el?.closest<HTMLElement>("[data-slot-id]");
  return pad?.dataset.slotId ?? null;
}

/** Decide which pads receive which files. Exported for tests. */
export function planDrop(
  slots: { id: string; path: string | null }[],
  paths: string[],
  targetSlotId: string | null,
): { slotId: string; path: string }[] {
  const audio = paths.filter((p) => AUDIO_FILE_RE.test(p));
  if (audio.length === 0) return [];
  const out: { slotId: string; path: string }[] = [];
  if (targetSlotId) {
    const start = slots.findIndex((s) => s.id === targetSlotId);
    if (start < 0) return [];
    // First file on the target, the rest on the following pads (overwriting).
    for (let i = 0; i < audio.length && start + i < slots.length; i++) out.push({ slotId: slots[start + i].id, path: audio[i] });
    return out;
  }
  const empty = slots.filter((s) => !s.path);
  for (let i = 0; i < audio.length && i < empty.length; i++) out.push({ slotId: empty[i].id, path: audio[i] });
  return out;
}

export function applyDrop(paths: string[], targetSlotId: string | null): void {
  const s = useDeckStore.getState();
  const bank = s.banks.find((b) => b.id === s.currentBankId);
  if (!bank) return;
  const plan = planDrop(bank.slots, paths, targetSlotId);
  for (const { slotId, path } of plan) s.assignFile(slotId, path);
}

export function installFileDrop(): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const u = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        if (payload.type === "enter" || payload.type === "over") {
          // Positions arrive in CSS pixels on macOS WebKit (see playque).
          setDragOver(payload.position ? slotAtPoint(payload.position.x, payload.position.y) : null);
          return;
        }
        if (payload.type === "leave") {
          setDragOver(null);
          return;
        }
        if (payload.type !== "drop") return;
        const target = payload.position ? slotAtPoint(payload.position.x, payload.position.y) : null;
        setDragOver(null);
        applyDrop(payload.paths ?? [], target);
      });
      if (cancelled) u();
      else unlisten = u;
    } catch {
      // Browser dev mode: no OS drops.
    }
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
