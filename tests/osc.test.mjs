import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

const i = (v) => ({ type: "int", value: String(v) });
const f = (v) => ({ type: "float", value: String(v) });

test("OSC addresses map to commands (1-based on the wire)", async () => {
  const { osc } = await loadDeck();
  const m = osc.oscToCommand;
  assert.deepEqual(m("/bgmdeck/play", [i(3)]), { type: "play", pad: 2, fade: undefined });
  assert.deepEqual(m("/bgmdeck/play/10", []), { type: "play", pad: 9, fade: undefined });
  assert.deepEqual(m("/bgmdeck/play/1", [f(2.5)]), { type: "play", pad: 0, fade: 2.5 });
  assert.deepEqual(m("/bgmdeck/play", [i(3), f(1)]), { type: "play", pad: 2, fade: 1 });
  assert.deepEqual(m("/bgmdeck/bank/2/play/4", []), { type: "play", pad: 3, bank: 1 });
  assert.deepEqual(m("/bgmdeck/bank/2/play", [i(4)]), { type: "play", pad: 3, bank: 1 });
  assert.deepEqual(m("/bgmdeck/stop", []), { type: "stop", fade: undefined });
  assert.deepEqual(m("/bgmdeck/stop", [f(0.5)]), { type: "stop", fade: 0.5 });
  assert.deepEqual(m("/bgmdeck/stop/now", []), { type: "stopNow" });
  assert.deepEqual(m("/bgmdeck/bank", [i(2)]), { type: "bank", index: 1 });
  assert.deepEqual(m("/bgmdeck/bank/3", []), { type: "bank", index: 2 });
  assert.deepEqual(m("/bgmdeck/bank/next", []), { type: "bankNext" });
  assert.deepEqual(m("/bgmdeck/bank/prev", []), { type: "bankPrev" });
  assert.deepEqual(m("/bgmdeck/master", [f(0.5)]), { type: "master", value: 0.5 });
  assert.deepEqual(m("/bgmdeck/master", [f(1.7)]), { type: "master", value: 1 });
  assert.deepEqual(m("/bgmdeck/pad/2/volume", [f(0.25)]), { type: "padVolume", pad: 1, value: 0.25 });
  assert.deepEqual(m("/bgmdeck/duck", [i(1)]), { type: "duck", on: true });
  assert.deepEqual(m("/bgmdeck/duck", [i(0)]), { type: "duck", on: false });
  assert.deepEqual(m("/bgmdeck/duck", []), { type: "duck", on: "toggle" });
  assert.deepEqual(m("/bgmdeck/duck/on", []), { type: "duck", on: true });
  assert.deepEqual(m("/bgmdeck/duck/toggle", []), { type: "duck", on: "toggle" });
  assert.deepEqual(m("/bgmdeck/ping", []), { type: "ping" });
  // Not ours / malformed
  assert.equal(m("/playque/go", []), null);
  assert.equal(m("/bgmdeck/play", [i(11)]), null);
  assert.equal(m("/bgmdeck/play/0", []), null);
  assert.equal(m("/bgmdeck/play", []), null);
  assert.equal(m("/bgmdeck/pad/3/pan", [f(0)]), null);
  assert.equal(m("/bgmdeck/nonsense", []), null);
});

test("handleOsc executes commands, logs everything, and answers ping", async () => {
  const { osc, store, calls } = await loadDeck({ deckPlay: async () => 7 });
  const s = store.getState();
  s.addBank();
  const bank2 = store.getState().banks[1];
  s.assignFile(bank2.slots[0].id, "/m/x.wav");
  s.selectBankIndex(0);
  osc.handleOsc({ address: "/bgmdeck/bank/2/play/1", args: [], from: "10.0.0.5:5000" });
  await new Promise((r) => setTimeout(r, 0));
  const play = calls.filter((c) => c.name === "deckPlay").pop();
  assert.equal(play.args[0], bank2.slots[0].id);
  assert.equal(store.getState().currentBankId, bank2.id, "switches to the bank");
  osc.handleOsc({ address: "/bgmdeck/ping", args: [], from: "10.0.0.5:5000" });
  const pong = calls.find((c) => c.name === "oscSend");
  assert.deepEqual(pong.args, ["10.0.0.5:5000", "/bgmdeck/pong", []]);
  osc.handleOsc({ address: "/other/thing", args: [{ type: "int", value: "1" }], from: "x" });
  const log = osc.oscLog();
  assert.equal(log[0].address, "/other/thing");
  assert.equal(log[0].handled, false);
  assert.equal(log[2].address, "/bgmdeck/bank/2/play/1");
  assert.equal(log[2].handled, true);
  osc.handleOsc({ address: "/bgmdeck/duck", args: [{ type: "int", value: "1" }], from: "x" });
  assert.equal(store.getState().duckOn, true);
  osc.handleOsc({ address: "/bgmdeck/master", args: [{ type: "float", value: "0.5" }], from: "x" });
  assert.equal(store.getState().settings.master, 0.5);
});

test("state feedback describes the newest live voice and only sends to targets", async () => {
  const { oscFeedback, store, prefsStore, calls } = await loadDeck();
  const s = store.getState();
  const id = s.banks[0].slots[1].id;
  s.assignFile(id, "/m/Dinner Set.mp3");
  const voices = [
    { gen: 1, slotId: s.banks[0].slots[0].id, position: 5, duration: 60, stage: "fadeOut", env: 0.5 },
    { gen: 2, slotId: id, position: 12.3, duration: 200, stage: "fadeIn", env: 0.2 },
  ];
  const f = oscFeedback.feedbackState(voices, store.getState().banks);
  assert.deepEqual(f, { state: "playing", bank: 1, pad: 2, name: "Dinner Set", position: 12.3, duration: 200 });
  assert.deepEqual(oscFeedback.feedbackState([], store.getState().banks).state, "stopped");
  assert.equal(oscFeedback.feedbackState([voices[0]], store.getState().banks).state, "fading");
  assert.equal(oscFeedback.feedbackArgs(f)[4].value, "12.30");

  const off = oscFeedback.installOscFeedback();
  store.getState().applyStatus({ voices, peak: [0, 0], master: 1, duck: 1, underruns: 0 });
  assert.equal(calls.filter((c) => c.name === "oscSend").length, 0, "no targets, nothing sent");
  prefsStore.getState().setRemote({ oscFeedbackTargets: ["192.168.0.9:9000"] });
  const sent = calls.filter((c) => c.name === "oscSend");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args[0], "192.168.0.9:9000");
  assert.equal(sent[0].args[1], "/bgmdeck/state");
  assert.equal(sent[0].args[2][0].value, "playing");
  // Same identity within a second: suppressed.
  store.getState().applyStatus({ voices: voices.map((v) => ({ ...v, position: v.position + 0.1 })), peak: [0, 0], master: 1, duck: 1, underruns: 0 });
  assert.equal(calls.filter((c) => c.name === "oscSend").length, 1);
  off();
});

test("OSC listener prefs reach the engine and errors are kept", async () => {
  const { osc, prefsStore } = await loadDeck();
  const configured = [];
  const off = osc.installOscListener(async (port, iface) => {
    configured.push([port, iface]);
    if (iface === "bad0") throw "not connected";
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(configured, [[null, ""]]);
  prefsStore.getState().setRemote({ oscEnabled: true, oscPort: 9100 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(configured.at(-1), [9100, ""]);
  assert.equal(prefsStore.getState().oscError, null);
  prefsStore.getState().setRemote({ oscInterface: "bad0" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prefsStore.getState().oscError, "not connected");
  off();
});
