// Pad-to-pad swap by dragging with the pointer. HTML5 drag and drop is not
// usable inside the webview on Windows while OS file drops are enabled, so
// this tracks pointer events and the pad under the cursor by hit-testing.
import { slotAtPoint } from "./dropFiles";

const THRESHOLD_PX = 8;
let consumedClick = false;
let overListeners = new Set<(id: string | null) => void>();
let over: string | null = null;
let dragging: string | null = null;

export function subscribePadDragOver(fn: (id: string | null) => void): () => void {
  overListeners.add(fn);
  return () => {
    overListeners.delete(fn);
  };
}

export function padDragSource(): string | null {
  return dragging;
}

function setOver(id: string | null) {
  if (id === over) return;
  over = id;
  overListeners.forEach((fn) => fn(id));
}

/** Call from a pad's pointerdown. Resolves to a swap on pointerup over another pad. */
export function beginPadDrag(slotId: string, x0: number, y0: number, swap: (a: string, b: string) => void): void {
  let started = false;
  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD_PX) return;
      started = true;
      dragging = slotId;
      document.body.style.cursor = "grabbing";
    }
    const id = slotAtPoint(e.clientX, e.clientY);
    setOver(id && id !== slotId ? id : null);
  };
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!started) return;
    document.body.style.cursor = "";
    const target = e.type === "pointerup" ? slotAtPoint(e.clientX, e.clientY) : null;
    dragging = null;
    setOver(null);
    if (target && target !== slotId) swap(slotId, target);
    // Swallow the click that follows the pointerup.
    consumedClick = true;
    setTimeout(() => {
      consumedClick = false;
    }, 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

export function padDragConsumedClick(): boolean {
  return consumedClick;
}

export function resetPadDragForTests(): void {
  consumedClick = false;
  over = null;
  dragging = null;
  overListeners = new Set();
}
