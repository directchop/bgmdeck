import { useSyncExternalStore } from "react";
import { hasNativeDialogs } from "./bridge";
import { confirmDiscard } from "./deckIO";
import { useDeckStore } from "./store/deck";
import { loadUpdatePrefs, updatesAllowedNow } from "./updatePolicy";

export const UPDATES_ENABLED = true;

export type UpdateState = "idle" | "checking" | "none" | "available" | "downloading" | "error";

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  notes?: string;
  progress?: number;
  error?: string;
}

type PendingUpdate = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

let status: UpdateStatus = { state: "idle" };
let pending: PendingUpdate = null;
const listeners = new Set<() => void>();

function setStatus(next: UpdateStatus) {
  status = next;
  listeners.forEach((l) => l());
}

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

const playing = () => useDeckStore.getState().voices.length > 0;

export async function checkForUpdates(silent = false): Promise<void> {
  if (!UPDATES_ENABLED) return;
  if (!hasNativeDialogs()) {
    if (!silent) setStatus({ state: "error", error: "Updates are only available in the desktop app." });
    return;
  }
  if (!updatesAllowedNow(playing())) {
    if (!silent) setStatus({ state: "error", error: "Stop playback before checking for updates." });
    return;
  }
  if (status.state === "checking" || status.state === "downloading") return;
  setStatus({ state: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const channel = loadUpdatePrefs().channel;
    pending = await check(channel === "beta" ? { headers: { "x-bgmdeck-channel": "beta" } } : undefined);
    setStatus(pending ? { state: "available", version: pending.version, notes: pending.body } : { state: "none" });
  } catch (e) {
    setStatus(silent ? { state: "idle" } : { state: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export async function installUpdate(): Promise<void> {
  if (!pending) return;
  if (!updatesAllowedNow(playing())) {
    setStatus({ state: "error", version: pending.version, error: "Stop playback before installing an update." });
    return;
  }
  if (!(await confirmDiscard())) return;
  const base = { version: pending.version, notes: pending.body };
  let total = 0;
  let received = 0;
  setStatus({ ...base, state: "downloading", progress: 0 });
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        received += ev.data.chunkLength;
        setStatus({ ...base, state: "downloading", progress: total ? received / total : undefined });
      }
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    setStatus({ ...base, state: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
