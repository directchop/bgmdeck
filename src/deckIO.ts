// New / Open / Save / Save As, the unsaved-changes guard and the window title.
import {
  deckPickOpenPath,
  deckPickSavePath,
  deckRead,
  deckSetDirty,
  deckWrite,
  dialogConfirm,
  dialogMessage,
  fileExists,
  hasNativeDialogs,
  logFrontend,
  windowSetTitle,
} from "./bridge";
import { deckNameFromPath, parseDeck, serializeDeck } from "./deckFile";
import { useDeckStore } from "./store/deck";

export async function confirmDiscard(): Promise<boolean> {
  const s = useDeckStore.getState();
  if (!s.dirty) return true;
  return dialogConfirm("Unsaved changes", `"${s.name}" has unsaved changes. Discard them?`);
}

export async function newDeck(): Promise<void> {
  if (!(await confirmDiscard())) return;
  await useDeckStore.getState().stop(0.3);
  useDeckStore.getState().resetDeck();
}

/** Mark pads whose files are gone. Returns the missing paths. */
export async function checkMissingFiles(): Promise<string[]> {
  const s = useDeckStore.getState();
  const missing: string[] = [];
  for (const bank of s.banks) {
    for (const slot of bank.slots) {
      if (!slot.path) continue;
      let exists = true;
      try {
        exists = await fileExists(slot.path);
      } catch {
        exists = true;
      }
      if (!exists) {
        missing.push(slot.path);
        s.setSlotMissing(slot.id, true);
      }
    }
  }
  return missing;
}

export async function openDeckFromPath(path: string): Promise<boolean> {
  let data;
  try {
    data = parseDeck(await deckRead(path));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    void logFrontend("error", `Open failed: ${message}`).catch(() => {});
    await dialogMessage("Could not open deck", message, true);
    return false;
  }
  await useDeckStore.getState().stop(0.3);
  useDeckStore.getState().loadDeckData(data, path);
  const missing = await checkMissingFiles();
  if (missing.length) {
    await dialogMessage(
      "Missing audio files",
      `${missing.length} file${missing.length === 1 ? "" : "s"} could not be found:\n\n${missing.slice(0, 8).join("\n")}${missing.length > 8 ? "\n…" : ""}\n\nThose pads are marked and will stay silent until you re-assign them.`,
    );
  }
  return true;
}

export async function openDeck(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const path = await deckPickOpenPath();
  if (!path) return;
  await openDeckFromPath(path);
}

export async function saveDeck(saveAs = false): Promise<boolean> {
  const s = useDeckStore.getState();
  let path = s.deckPath;
  if (saveAs || !path) {
    path = await deckPickSavePath(s.name === "Untitled" ? "Untitled deck" : s.name);
    if (!path) return false;
  }
  try {
    const data = s.getDeckData();
    if (!s.deckPath || saveAs) {
      // Take the file name as the deck name on first save / Save As.
      data.name = deckNameFromPath(path);
    }
    await deckWrite(path, serializeDeck(data));
    useDeckStore.setState({ name: data.name });
    useDeckStore.getState().markSaved(path);
    void logFrontend("info", `Saved deck to ${path}`).catch(() => {});
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    void logFrontend("error", `Save failed: ${message}`).catch(() => {});
    await dialogMessage("Could not save deck", message, true);
    return false;
  }
}

/** "Gala • — BGM Deck": the OS title bar carries the deck name. */
export function windowTitle(name: string, dirty: boolean): string {
  return `${name || "Untitled"}${dirty ? " •" : ""} — BGM Deck`;
}

/** Mirror the dirty flag to Rust (close prompt) and keep the title current. */
export function installCloseGuard(): () => void {
  if (!hasNativeDialogs()) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useDeckStore.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }
  const syncTitle = (name: string, dirty: boolean) => windowSetTitle(windowTitle(name, dirty)).catch(() => {});
  const initial = useDeckStore.getState();
  deckSetDirty(initial.dirty).catch(() => {});
  syncTitle(initial.name, initial.dirty);
  return useDeckStore.subscribe((s, prev) => {
    if (s.dirty !== prev.dirty) deckSetDirty(s.dirty).catch(() => {});
    if (s.dirty !== prev.dirty || s.name !== prev.name) syncTitle(s.name, s.dirty);
  });
}
