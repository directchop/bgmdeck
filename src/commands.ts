// Single dispatch point for everything the menu bar and the keyboard can
// trigger. Menu events (`menu-command`) and keydown handlers both call
// `runCommand`, so adding an action here makes it reachable from both.
import { filePickAudio, openPath, openUrl } from "./bridge";
import { CommandDeduper, type CommandSource } from "./commandDedupe";
import { newDeck, openDeck, saveDeck } from "./deckIO";
import { useDeckStore } from "./store/deck";
import { useUiStore } from "./uiStore";
import { checkForUpdates } from "./updater";

export const DOCS_URL = "https://github.com/directchop/bgmdeck#readme";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const isTypingTarget = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

const typing = () => isTypingTarget(typeof document === "undefined" ? null : document.activeElement);

function editText(command: "undo" | "redo" | "selectAll" | "delete") {
  try {
    document.execCommand(command);
  } catch {
    /* not supported here */
  }
}

const selected = () => {
  const s = useDeckStore.getState();
  return s.selectedSlotId;
};

export async function chooseFileForSlot(slotId: string): Promise<void> {
  const path = await filePickAudio();
  if (path) useDeckStore.getState().assignFile(slotId, path);
}

const handlers: Record<string, (ctx: { source: CommandSource | "ui" }) => void> = {
  // File
  "file.new": () => void newDeck(),
  "file.open": () => void openDeck(),
  "file.save": () => void saveDeck(),
  "file.saveAs": () => void saveDeck(true),
  "file.reveal": () => {
    const path = useDeckStore.getState().deckPath;
    if (path) void openPath(path.replace(/[\\/][^\\/]*$/, ""));
  },

  // Edit
  "edit.undo": () => (typing() ? editText("undo") : useDeckStore.getState().undo()),
  "edit.redo": () => (typing() ? editText("redo") : useDeckStore.getState().redo()),
  "edit.selectAll": () => {
    if (typing()) editText("selectAll");
  },
  "edit.escape": () => {
    const ui = useUiStore.getState();
    if (ui.showShortcuts) ui.setShowShortcuts(false);
    else if (ui.renamingSlotId) ui.setRenamingSlotId(null);
    else if (ui.renamingBankId) ui.setRenamingBankId(null);
    else useDeckStore.getState().selectSlot(null);
  },

  // Pads
  "pad.rename": () => {
    const id = selected();
    if (id) useUiStore.getState().setRenamingSlotId(id);
  },
  "pad.choose": () => {
    const id = selected();
    if (id) void chooseFileForSlot(id);
  },
  "pad.clear": () => {
    if (typing()) return editText("delete");
    const id = selected();
    if (id) useDeckStore.getState().clearSlot(id);
  },

  // Banks
  "bank.add": () => useDeckStore.getState().addBank(),
  "bank.rename": () => {
    const s = useDeckStore.getState();
    useUiStore.getState().setTab("pads");
    useUiStore.getState().setRenamingBankId(s.currentBankId);
  },
  "bank.delete": () => {
    const s = useDeckStore.getState();
    if (s.banks.length > 1) s.deleteBank(s.currentBankId);
  },
  "bank.next": () => useDeckStore.getState().nextBank(),
  "bank.prev": () => useDeckStore.getState().prevBank(),

  // View
  "view.pads": () => useUiStore.getState().setTab("pads"),
  "view.settings": () => useUiStore.getState().setTab("settings"),
  "app.settings": () => useUiStore.getState().setTab("settings"),
  "view.toggleSettings": () => {
    const ui = useUiStore.getState();
    ui.setTab(ui.tab === "pads" ? "settings" : "pads");
  },
  "view.waveforms": () => {
    const ui = useUiStore.getState();
    ui.setShowWaveforms(!ui.showWaveforms);
  },

  // Deck
  "deck.stop": () => void useDeckStore.getState().stop(),
  "deck.stopNow": () => void useDeckStore.getState().stopNow(),
  "deck.duck": () => useDeckStore.getState().toggleDuck(),

  // Help
  "help.shortcuts": () => {
    const ui = useUiStore.getState();
    ui.setShowShortcuts(!ui.showShortcuts);
  },
  "help.remote": () => {
    const ui = useUiStore.getState();
    ui.setTab("settings");
    ui.setSettingsSection("remote");
  },
  "help.docs": () => void openUrl(DOCS_URL),
  "help.checkUpdates": () => {
    const ui = useUiStore.getState();
    ui.setTab("settings");
    ui.setSettingsSection("updates");
    void checkForUpdates(false);
  },
};
for (let n = 1; n <= 10; n++) {
  handlers[`deck.play.${n}`] = () => void useDeckStore.getState().playPad(n - 1);
}

export const COMMAND_IDS = Object.keys(handlers);

const deduper = new CommandDeduper();

export function runCommand(id: string, source: CommandSource | "ui" = "ui"): boolean {
  const handler = handlers[id];
  if (!handler) {
    console.warn("Unknown command", id);
    return false;
  }
  if (source !== "ui" && !deduper.accept(id, source)) return false;
  handler({ source });
  return true;
}

/** Record that a native accelerator already handled this key so the menu
 *  echo (Windows) is swallowed. */
export function noteNativeKey(id: string): void {
  deduper.accept(id, "key");
}

/** Map a keydown to a command id. `typing` = focus is in a text field. */
export function commandForKey(
  e: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  typing: boolean,
): string | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) {
    switch (e.code) {
      case "KeyS":
        return e.shiftKey ? "file.saveAs" : "file.save";
      case "KeyO":
        return "file.open";
      case "KeyN":
        return e.shiftKey ? "bank.add" : "file.new";
      case "Comma":
        return "app.settings";
      case "Digit1":
        return "view.pads";
      case "Digit2":
        return "view.settings";
    }
    if (typing) return null;
    switch (e.code) {
      case "KeyZ":
        return e.shiftKey ? "edit.redo" : "edit.undo";
      case "KeyY":
        return "edit.redo";
    }
    return null;
  }
  if (typing || e.altKey) return null;
  switch (e.code) {
    case "Tab":
      return e.shiftKey ? null : "view.toggleSettings";
    case "Space":
      return e.shiftKey ? "deck.stopNow" : "deck.stop";
    case "Escape":
      return "edit.escape";
    case "Delete":
    case "Backspace":
      return "pad.clear";
    case "Enter":
    case "NumpadEnter":
      return "pad.rename";
    case "KeyD":
      return "deck.duck";
    case "BracketLeft":
      return "bank.prev";
    case "BracketRight":
      return "bank.next";
    case "Slash":
      return e.shiftKey ? "help.shortcuts" : null;
    case "Digit0":
    case "Numpad0":
      return "deck.play.10";
  }
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) return `deck.play.${m[1]}`;
  return null;
}

/** Window keydown handler. */
export function handleShortcutKeyDown(e: KeyboardEvent): void {
  const typing = isTypingTarget(e.target);
  const id = commandForKey(e, typing);
  if (!id) return;
  e.preventDefault();
  runCommand(id, "key");
}
