import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

test("planDrop: on a pad fills forward, elsewhere fills empty pads, ignores non-audio", async () => {
  const { drop } = await loadDeck();
  const slots = [
    { id: "a", path: "/x.wav" },
    { id: "b", path: null },
    { id: "c", path: null },
    { id: "d", path: "/y.wav" },
  ];
  assert.deepEqual(drop.planDrop(slots, ["/1.mp3", "/notes.txt", "/2.flac"], "c"), [
    { slotId: "c", path: "/1.mp3" },
    { slotId: "d", path: "/2.flac" },
  ]);
  assert.deepEqual(drop.planDrop(slots, ["/1.mp3", "/2.aiff", "/3.wav"], null), [
    { slotId: "b", path: "/1.mp3" },
    { slotId: "c", path: "/2.aiff" },
  ]);
  assert.deepEqual(drop.planDrop(slots, ["/readme.md"], "a"), []);
  assert.deepEqual(drop.planDrop(slots, ["/1.mp3"], "zzz"), []);
});

test("prefs parse defaults and clamp", async () => {
  const { prefs } = await loadDeck();
  assert.deepEqual(prefs.parseAudioPrefs(null), prefs.DEFAULT_AUDIO_PREFS);
  assert.deepEqual(prefs.parseAudioPrefs({ deviceId: "CoreAudio::X", sampleRate: 96000, left: 2, right: 3 }), {
    deviceId: "CoreAudio::X", sampleRate: 96000, bufferSize: 0, left: 2, right: 3,
  });
  const r = prefs.parseRemotePrefs({ oscEnabled: true, oscPort: 70000, oscFeedbackTargets: ["a:1", "", 3], midi: { padNotes: [1, 2], channel: 20, stopNote: 200 } });
  assert.equal(r.oscPort, 9100);
  assert.deepEqual(r.oscFeedbackTargets, ["a:1"]);
  assert.equal(r.midi.padNotes[0], 1);
  assert.equal(r.midi.padNotes[2], 38);
  assert.equal(r.midi.channel, 0);
  assert.equal(r.midi.stopNote, 46);
});

test("session round-trips the working deck including dirty state and bank", async () => {
  const { session, store, localStorage } = await loadDeck();
  const s = store.getState();
  s.addBank();
  s.assignFile(store.getState().banks[1].slots[0].id, "/m/a.wav");
  session.saveSession();
  assert.ok(localStorage.getItem(session.SESSION_KEY));
  // Fresh store in the same storage
  s.resetDeck();
  assert.equal(store.getState().banks.length, 1);
  assert.equal(session.restoreSession(), true);
  assert.equal(store.getState().banks.length, 2);
  assert.equal(store.getState().banks[1].slots[0].path, "/m/a.wav");
  assert.equal(store.getState().dirty, true);
  assert.equal(store.getState().currentBankId, store.getState().banks[1].id);
  localStorage.setItem(session.SESSION_KEY, "{bad");
  assert.equal(session.restoreSession(), false);
  assert.equal(localStorage.getItem(session.SESSION_KEY), null);
});

test("engine sync loads, updates and unloads pads with bounded concurrency", async () => {
  let resolveLoad;
  const pending = [];
  const { engineSync, store, calls } = await loadDeck({
    slotLoad: () => new Promise((r) => { pending.push(r); resolveLoad = r; }),
  });
  const off = engineSync.installEngineSync();
  const s = store.getState();
  const ids = s.banks[0].slots.map((x) => x.id);
  for (let i = 0; i < 5; i++) s.assignFile(ids[i], `/m/${i}.wav`);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.name === "slotLoad").length, 3, "three loads in flight");
  pending.splice(0).forEach((r) => r({ duration: 42, peaks: [0.5], sampleRate: 48000, channels: 2 }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.name === "slotLoad").length, 5);
  assert.equal(store.getState().banks[0].slots[0].duration, 42);
  pending.splice(0).forEach((r) => r({ duration: 7, peaks: [], sampleRate: 48000, channels: 2 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.getState().banks[0].slots[4].duration, 7);
  // Loop / volume changes are live, clearing unloads.
  store.getState().setSlotLoop(ids[0], false);
  store.getState().setSlotVolume(ids[0], 0.5);
  store.getState().clearSlot(ids[1]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.find((c) => c.name === "slotSetLooping").args, [ids[0], false]);
  assert.deepEqual(calls.find((c) => c.name === "slotSetVolume").args, [ids[0], 0.5]);
  assert.ok(calls.some((c) => c.name === "slotUnload" && c.args[0] === ids[1]));
  // Settings reach the engine
  store.getState().updateSettings({ fadeCurve: "linear" });
  store.getState().setMaster(0.3);
  store.getState().toggleDuck();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.find((c) => c.name === "deckSetCurve").args, ["linear"]);
  assert.deepEqual(calls.find((c) => c.name === "deckSetMaster").args, [0.3]);
  assert.deepEqual(calls.find((c) => c.name === "deckSetDuck").args, [true, 0.25, 0.6]);
  off();
  void resolveLoad;
});

test("format helpers", async () => {
  const { format } = await loadDeck();
  assert.equal(format.formatTime(0), "0:00");
  assert.equal(format.formatTime(65.9), "1:05");
  assert.equal(format.formatTime(3725), "1:02:05");
  assert.equal(format.formatTime(null), "--:--");
  assert.equal(format.gainToDb(1), "+0.0 dB".replace("+", "")); // 0 dB prints without sign
  assert.equal(format.gainToDb(0.5), "-6.0 dB");
  assert.equal(format.gainToDb(0), "-∞ dB");
  assert.ok(Math.abs(format.faderToGain(format.gainToFader(0.3)) - 0.3) < 1e-9);
});
