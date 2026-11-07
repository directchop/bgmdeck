// Reopens the output after cpal reports a stream error (device unplugged,
// sample rate changed by another app). Tries the device in use first, then
// the default output. Playback that was running is lost; the pads re-prime.
import { audioRestart, logFrontend, onAudioStreamError } from "./bridge";
import { seedEngine } from "./engineSync";
import { usePrefsStore } from "./prefsStore";
import { useDeckStore } from "./store/deck";

export const RECOVERY_DELAYS_MS = [500, 2000, 5000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let recovering = false;

export async function recoverAudioEngine(message: string, delays: number[] = RECOVERY_DELAYS_MS): Promise<string | null> {
  useDeckStore.getState().setEngineStarted(false, message);
  void logFrontend("error", `Audio stream error: ${message}`).catch(() => {});
  if (recovering) return null;
  recovering = true;
  try {
    const prefs = usePrefsStore.getState();
    const wanted = prefs.applied?.deviceId ?? prefs.audio.deviceId;
    const attempts: (string | null)[] = [];
    for (const _ of delays.length ? delays : [0]) attempts.push(wanted);
    attempts.push(null);
    for (let i = 0; i < attempts.length; i++) {
      const wait = delays[Math.min(i, delays.length - 1)] ?? 0;
      if (wait > 0) await sleep(wait);
      const a = prefs.audio;
      try {
        const applied = await audioRestart(attempts[i], a.sampleRate || null, a.bufferSize || null);
        usePrefsStore.getState().setApplied(applied);
        useDeckStore.getState().setEngineStarted(true, null);
        seedEngine();
        void logFrontend("info", `Audio output recovered on ${applied.deviceId}`).catch(() => {});
        return applied.deviceId;
      } catch (err) {
        void logFrontend("warn", `Audio recovery attempt ${i + 1} failed: ${String(err)}`).catch(() => {});
      }
    }
    return null;
  } finally {
    recovering = false;
  }
}

export function installAudioRecovery(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  onAudioStreamError(({ message }) => {
    void recoverAudioEngine(message);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
