import assert from "node:assert";
import test from "node:test";
import { loadDeck, tick } from "./load-deck.mjs";

function deckWithFiles(store) {
  const s = store.getState();
  const bank = s.banks[0];
  s.assignFile(bank.slots[0].id, "/m/a.wav");
  s.assignFile(bank.slots[1].id, "/m/b.wav");
  return store.getState().banks[0];
}

test("play crossfades from the current pad and tap-to-stop fades it out", async () => {
  const { store, calls } = await loadDeck({ deckPlay: async () => 1 });
  const bank = deckWithFiles(store);
  const a = bank.slots[0].id;
  const b = bank.slots[1].id;
  await store.getState().play(a);
  let play = calls.filter((c) => c.name === "deckPlay").pop();
  assert.deepEqual(play.args, [a, 1, 0.05, 3]); // start fade from silence, crossfade length as fade-out
  // Engine reports it playing
  store.getState().applyStatus({ voices: [{ gen: 1, slotId: a, position: 1, duration: 10, stage: "steady", env: 1 }], peak: [0, 0], master: 1, duck: 1, underruns: 0 });
  await store.getState().play(b);
  play = calls.filter((c) => c.name === "deckPlay").pop();
  assert.deepEqual(play.args, [b, 1, 3, 3]); // crossfade in
  // Tapping the playing pad again stops it with the stop fade.
  await store.getState().play(a);
  const stop = calls.filter((c) => c.name === "deckStopSlot").pop();
  assert.deepEqual(stop.args, [a, 3]);
  // Shift (restart) bypasses tap-to-stop.
  await store.getState().play(a, { restart: true });
  play = calls.filter((c) => c.name === "deckPlay").pop();
  assert.equal(play.args[0], a);
  // Empty pads never reach the engine.
  const before = calls.length;
  await store.getState().play(bank.slots[5].id);
  assert.equal(calls.length, before);
});

test("play errors land on the pad instead of throwing", async () => {
  const { store } = await loadDeck({ deckPlay: async () => { throw "Audio engine is not running"; } });
  const bank = deckWithFiles(store);
  await store.getState().play(bank.slots[0].id);
  assert.equal(store.getState().banks[0].slots[0].error, "Audio engine is not running");
});

test("banks: add / rename / delete / navigate, and pad helpers", async () => {
  const { store, deck } = await loadDeck();
  const s = store.getState();
  s.addBank();
  s.addBank();
  assert.equal(store.getState().banks.length, 3);
  assert.equal(store.getState().currentBankId, store.getState().banks[2].id);
  s.renameBank(store.getState().banks[1].id, "Dinner");
  assert.equal(store.getState().banks[1].name, "Dinner");
  s.prevBank();
  assert.equal(store.getState().currentBankId, store.getState().banks[1].id);
  s.nextBank();
  s.nextBank(); // wraps
  assert.equal(store.getState().currentBankId, store.getState().banks[0].id);
  const deleted = store.getState().banks[0].id;
  s.deleteBank(deleted);
  assert.equal(store.getState().banks.length, 2);
  assert.ok(!store.getState().banks.some((b) => b.id === deleted));
  // Can't delete the last bank
  s.deleteBank(store.getState().banks[0].id);
  s.deleteBank(store.getState().banks[0].id);
  assert.equal(store.getState().banks.length, 1);

  const bank = store.getState().banks[0];
  s.assignFile(bank.slots[3].id, "/m/c.wav");
  const found = deck.findSlot(store.getState().banks, bank.slots[3].id);
  assert.equal(found.slotIndex, 3);
  assert.equal(found.bankIndex, 0);
  s.swapSlots(bank.slots[3].id, bank.slots[0].id);
  assert.equal(store.getState().banks[0].slots[0].path, "/m/c.wav");
  assert.equal(store.getState().banks[0].slots[3].path, null);
});

test("undo / redo restore pads and settings and keep the deck dirty", async () => {
  const { store } = await loadDeck();
  const s = store.getState();
  const id = s.banks[0].slots[0].id;
  s.assignFile(id, "/m/a.wav");
  s.setSlotName(id, "Walk-in");
  s.updateSettings({ crossfadeSec: 8 });
  assert.equal(store.getState().undoStack.length, 3);
  s.undo();
  assert.equal(store.getState().settings.crossfadeSec, 3);
  assert.equal(store.getState().banks[0].slots[0].name, "Walk-in");
  s.undo();
  assert.equal(store.getState().banks[0].slots[0].name, "");
  s.redo();
  assert.equal(store.getState().banks[0].slots[0].name, "Walk-in");
  assert.equal(store.getState().dirty, true);
  s.redo();
  assert.equal(store.getState().settings.crossfadeSec, 8);
  assert.equal(store.getState().redoStack.length, 0);
});

test("clearSlot stops the pad and keeps its id; loadDeckData resets history", async () => {
  const { store, calls, deckFile } = await loadDeck();
  const s = store.getState();
  const id = s.banks[0].slots[0].id;
  s.assignFile(id, "/m/a.wav");
  s.clearSlot(id);
  await tick();
  assert.ok(calls.some((c) => c.name === "deckStopSlot" && c.args[0] === id));
  assert.equal(store.getState().banks[0].slots[0].id, id);
  assert.equal(store.getState().banks[0].slots[0].path, null);
  const data = deckFile.newDeckData();
  data.name = "Loaded";
  s.loadDeckData(data, "/shows/x.bgmdeck");
  assert.equal(store.getState().name, "Loaded");
  assert.equal(store.getState().deckPath, "/shows/x.bgmdeck");
  assert.equal(store.getState().dirty, false);
  assert.equal(store.getState().undoStack.length, 0);
});
