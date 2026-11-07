// Native menu bar glue: run menu commands through `runCommand`, and keep the
// menu's enabled flags and check marks following the stores.
import { menuSync, onMenuCommand, type MenuState } from "./bridge";
import { runCommand } from "./commands";
import { useDeckStore } from "./store/deck";
import { useUiStore } from "./uiStore";

export function menuStateFrom(
  s: Pick<ReturnType<typeof useDeckStore.getState>, "voices" | "undoStack" | "redoStack" | "selectedSlotId" | "deckPath" | "duckOn">,
  ui: Pick<ReturnType<typeof useUiStore.getState>, "tab" | "showWaveforms">,
): MenuState {
  return {
    playing: s.voices.length > 0,
    canUndo: s.undoStack.length > 0,
    canRedo: s.redoStack.length > 0,
    hasDeckPath: !!s.deckPath,
    padSelected: !!s.selectedSlotId,
    duckOn: s.duckOn,
    showWaveforms: ui.showWaveforms,
    tab: ui.tab,
  };
}

const sameState = (a: MenuState | null, b: MenuState) => !!a && (Object.keys(b) as (keyof MenuState)[]).every((k) => a[k] === b[k]);

export function installMenu(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  onMenuCommand((id) => runCommand(id, "menu")).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  let last: MenuState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    const next = menuStateFrom(useDeckStore.getState(), useUiStore.getState());
    if (sameState(last, next)) return;
    last = next;
    menuSync(next).catch((e) => console.error("menu_sync failed", e));
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(push, 30);
  };
  push();
  const offDeck = useDeckStore.subscribe(schedule);
  const offUi = useUiStore.subscribe(schedule);
  return () => {
    disposed = true;
    unlisten?.();
    offDeck();
    offUi();
    if (timer) clearTimeout(timer);
  };
}
