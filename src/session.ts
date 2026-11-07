// Keeps the working deck in localStorage so a reload or the next launch
// reopens it (including unsaved edits) instead of an empty deck.
import { parseDeck, serializeDeck } from "./deckFile";
import { useDeckStore } from "./store/deck";

export const SESSION_KEY = "bgmdeck.session.v1";
const SAVE_DELAY_MS = 300;

interface StoredSession {
  deck: string;
  path: string | null;
  dirty: boolean;
  bankId?: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function saveSession(): void {
  const s = useDeckStore.getState();
  const session: StoredSession = { deck: serializeDeck(s.getDeckData()), path: s.deckPath, dirty: s.dirty, bankId: s.currentBankId };
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (err) {
    console.error("Failed to store session", err);
  }
}

/** Load the stored session into the store. Returns whether one was restored. */
export function restoreSession(): boolean {
  const raw = storage()?.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const session: StoredSession = JSON.parse(raw);
    const data = parseDeck(session.deck);
    const store = useDeckStore.getState();
    store.loadDeckData(data, session.path ?? null);
    if (session.dirty) useDeckStore.setState({ dirty: true });
    if (session.bankId && data.banks.some((b) => b.id === session.bankId)) useDeckStore.setState({ currentBankId: session.bankId });
    return true;
  } catch (err) {
    console.error("Discarding unreadable session", err);
    storage()?.removeItem(SESSION_KEY);
    return false;
  }
}

/** Persist deck edits (debounced) and on unload. Returns a cleanup. */
export function installSessionPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    saveSession();
  };
  const unsubscribe = useDeckStore.subscribe((s, p) => {
    const changed =
      s.banks !== p.banks || s.settings !== p.settings || s.name !== p.name || s.deckPath !== p.deckPath ||
      s.dirty !== p.dirty || s.currentBankId !== p.currentBankId;
    if (!changed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  const onHide = () => {
    if (timer) flush();
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("beforeunload", onHide);
  return () => {
    unsubscribe();
    if (timer) flush();
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("beforeunload", onHide);
  };
}
