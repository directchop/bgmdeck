// State feedback to other machines (playque, a TouchOSC layout):
//   /bgmdeck/state  s state  i bank  i pad  s name  f position  f duration
// sent on every change of what plays, plus once a second while playing.
// state ∈ "stopped" | "playing" | "fading"
import { oscSend, type OscArg } from "./bridge";
import { slotLabel } from "./deckFile";
import { usePrefsStore } from "./prefsStore";
import { activeVoices, findSlot, useDeckStore } from "./store/deck";
import type { PlayingVoice } from "./store/types";

export interface FeedbackState {
  state: "stopped" | "playing" | "fading";
  bank: number;
  pad: number;
  name: string;
  position: number;
  duration: number;
}

export function feedbackState(
  voices: PlayingVoice[],
  banks: ReturnType<typeof useDeckStore.getState>["banks"],
): FeedbackState {
  const live = activeVoices(voices);
  const v = live[0] ?? voices.slice().sort((a, b) => b.gen - a.gen)[0];
  if (!v) return { state: "stopped", bank: 0, pad: 0, name: "", position: 0, duration: 0 };
  const found = findSlot(banks, v.slotId);
  return {
    state: live.length ? "playing" : "fading",
    bank: found ? found.bankIndex + 1 : 0,
    pad: found ? found.slotIndex + 1 : 0,
    name: found ? slotLabel(found.slot) : "",
    position: v.position,
    duration: v.duration ?? found?.slot.duration ?? 0,
  };
}

export function feedbackArgs(f: FeedbackState): OscArg[] {
  return [
    { type: "string", value: f.state },
    { type: "int", value: String(f.bank) },
    { type: "int", value: String(f.pad) },
    { type: "string", value: f.name },
    { type: "float", value: f.position.toFixed(2) },
    { type: "float", value: f.duration.toFixed(2) },
  ];
}

const identity = (f: FeedbackState) => `${f.state}|${f.bank}|${f.pad}|${f.name}`;

export function installOscFeedback(): () => void {
  let last = "";
  let lastSentAt = 0;
  const send = (force: boolean) => {
    const targets = usePrefsStore.getState().remote.oscFeedbackTargets;
    if (targets.length === 0) return;
    const s = useDeckStore.getState();
    const f = feedbackState(s.voices, s.banks);
    const id = identity(f);
    const now = Date.now();
    if (!force && id === last && (f.state === "stopped" || now - lastSentAt < 1000)) return;
    last = id;
    lastSentAt = now;
    const args = feedbackArgs(f);
    for (const t of targets) void oscSend(t, "/bgmdeck/state", args).catch(() => {});
  };
  const off = useDeckStore.subscribe((s, p) => {
    if (s.voices !== p.voices || s.banks !== p.banks) send(false);
  });
  const offPrefs = usePrefsStore.subscribe((s, p) => {
    if (s.remote.oscFeedbackTargets !== p.remote.oscFeedbackTargets) send(true);
  });
  return () => {
    off();
    offPrefs();
  };
}
